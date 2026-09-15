import { join } from "node:path";
import {
  parseChatSession,
  parseConversation,
  type SessionRelation
} from "@vermillion/shared";
import type {
  DiscoveredWorkspaceResult,
  HydratedSessionSnapshot,
  HydratedSessionWindowSnapshot,
  SessionDiscoveryProvider
} from "../../session-discovery.js";
import type { SessionIndexEntry } from "../../session-index.js";
import type { WorkspaceRecord } from "../../workspace-registry.js";
import type { PiRuntimePort } from "./runtime-port.js";
import {
  branchEntries,
  findPiSessionFile,
  readPiSessionFile,
  type PiSessionFile
} from "./session-file.js";
import {
  piEngineId,
  piProviderKind,
  piSessionIdForSession
} from "./session-identity.js";
import { buildPiTurnEntities, readPiTurnExecutionProfiles } from "./transcript.js";

type PiSessionRead = {
  file: PiSessionFile | undefined;
  snapshot: HydratedSessionSnapshot;
  allTurns: HydratedSessionSnapshot["turns"];
};

const forkSourceFrom = (
  entry: SessionIndexEntry
): { parentSessionId: string; sourceTurnId?: string } | undefined => {
  const metadata = entry.metadata ?? {};
  const parentSessionId = metadata.forkSourceSessionId;
  if (typeof parentSessionId !== "string" || !parentSessionId) {
    return undefined;
  }
  const sourceTurnId = metadata.forkSourceTurnId;
  return {
    parentSessionId,
    ...(typeof sourceTurnId === "string" && sourceTurnId ? { sourceTurnId } : {})
  };
};

/** 只列工作台自己创建的会话；外部 pi 会话不进入索引。 */
export class PiSessionDiscoveryProvider implements SessionDiscoveryProvider {
  public readonly engineId = piEngineId;

  private readonly runtimePort: PiRuntimePort;
  private readonly now: () => string;

  public constructor(options: { runtimePort: PiRuntimePort; now?: () => string }) {
    this.runtimePort = options.runtimePort;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public async discoverWorkspaces(
    _workspaces: readonly WorkspaceRecord[]
  ): Promise<ReadonlyMap<string, DiscoveredWorkspaceResult>> {
    return new Map();
  }

  public async ensureSessionExecutable(entry: SessionIndexEntry): Promise<boolean> {
    return (await this.readSessionFile(entry)) !== undefined;
  }

  public async hydrateSession(
    entry: SessionIndexEntry
  ): Promise<HydratedSessionSnapshot | undefined> {
    return (await this.read(entry)).snapshot;
  }

  public async hydrateSessionWindow(
    entry: SessionIndexEntry,
    input: {
      limit: number;
      cursor?: string;
      anchorTurnId?: string;
    }
  ): Promise<HydratedSessionWindowSnapshot | undefined> {
    const { snapshot } = await this.read(entry);
    const turns = snapshot.turns;
    const limit = Math.max(1, input.limit);
    let end = turns.length;
    if (input.cursor) {
      const beforeIndex = turns.findIndex((turn) => turn.turnId === input.cursor);
      end = beforeIndex >= 0 ? beforeIndex : turns.length;
    } else if (input.anchorTurnId) {
      const anchorIndex = turns.findIndex(
        (turn) => turn.turnId === input.anchorTurnId
      );
      end = anchorIndex >= 0 ? anchorIndex + 1 : turns.length;
    }
    const start = Math.max(0, end - limit);
    const pageTurns = turns.slice(start, end);
    const pageTurnIds = new Set(pageTurns.map((turn) => turn.turnId));
    const hasOlder = start > 0;
    const hasNewer = end < turns.length;
    return {
      ...snapshot,
      turns: pageTurns,
      messageBlocks: snapshot.messageBlocks.filter((block) =>
        pageTurnIds.has(block.turnId)
      ),
      toolCalls: snapshot.toolCalls.filter((call) => pageTurnIds.has(call.turnId)),
      terminalStreams: snapshot.terminalStreams.filter((stream) =>
        pageTurnIds.has(stream.turnId)
      ),
      hasOlder,
      hasNewer,
      ...(hasOlder && pageTurns[0] ? { olderCursor: pageTurns[0].turnId } : {}),
      ...(hasNewer && pageTurns.at(-1)
        ? { newerCursor: pageTurns.at(-1)!.turnId }
        : {})
    };
  }

  private async readSessionFile(
    entry: SessionIndexEntry
  ): Promise<PiSessionFile | undefined> {
    const sessionDir = this.runtimePort.sessionDirectory(entry.sessionId);
    const piSessionId =
      entry.providerSessionId ?? piSessionIdForSession(entry.sessionId);
    const path = await findPiSessionFile(join(sessionDir, "sessions"), piSessionId);
    return path ? readPiSessionFile(path) : undefined;
  }

  private async read(entry: SessionIndexEntry): Promise<PiSessionRead> {
    const file = await this.readSessionFile(entry);
    const entries = file ? branchEntries(file) : [];
    const fork = forkSourceFrom(entry);
    const entities = buildPiTurnEntities({
      sessionId: entry.sessionId,
      entries,
      ...(fork?.sourceTurnId ? { forkSourceTurnId: fork.sourceTurnId } : {}),
      executionProfiles: readPiTurnExecutionProfiles(entry.metadata)
    });
    const createdAt = file?.header.timestamp ?? entry.createdAt;
    const updatedAt = entries.at(-1)?.timestamp ?? entry.updatedAt;
    const cwd =
      file?.header.cwd ??
      (typeof entry.metadata?.cwd === "string" ? entry.metadata.cwd : undefined);
    const conversation = parseConversation({
      conversationId: entry.conversationId,
      workspaceId: entry.workspaceId,
      participantEngineIds: [piEngineId],
      activeSessionId: entry.sessionId,
      sessionIds: [entry.sessionId],
      createdAt,
      updatedAt
    });
    const session = parseChatSession({
      sessionId: entry.sessionId,
      conversationId: entry.conversationId,
      engineId: piEngineId,
      status: this.runtimePort.getActiveTurnId(entry.sessionId) ? "running" : "idle",
      title: entry.title,
      createdAt,
      updatedAt,
      archivedAt: entry.archivedAt,
      lastTurnId: entities.turns.at(-1)?.turnId ?? entry.lastTurnId,
      metadata: {
        ...(entry.metadata ?? {}),
        providerKind: piProviderKind,
        providerSessionId: entry.providerSessionId ?? piSessionIdForSession(entry.sessionId),
        ...(cwd ? { cwd } : {})
      }
    });
    const relations: SessionRelation[] = fork
      ? [
          {
            relationId: `${fork.parentSessionId}:${entry.sessionId}:fork`,
            parentSessionId: fork.parentSessionId,
            childSessionId: entry.sessionId,
            relationType: "fork",
            ...(fork.sourceTurnId ? { sourceTurnId: fork.sourceTurnId } : {}),
            createdAt
          }
        ]
      : [];
    const snapshot: HydratedSessionSnapshot = {
      workspaceId: entry.workspaceId,
      conversation,
      session,
      turns: entities.turns,
      messageBlocks: entities.messageBlocks,
      toolCalls: entities.toolCalls,
      terminalStreams: entities.terminalStreams,
      sessionRelations: relations,
      runtimeBinding: {
        providerKind: piProviderKind,
        providerSessionId: session.metadata?.providerSessionId as string
      }
    };
    void this.now;
    return { file, snapshot, allTurns: entities.turns };
  }
}
