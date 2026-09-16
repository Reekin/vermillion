import { randomUUID } from "node:crypto";
import type { SessionAgentActionsProvider } from "../../session-actions.js";
import type {
  SessionActionDescriptor,
  SessionActionKind,
  SessionActionOptions,
  SessionActionProviderContext,
  SessionActionResult
} from "../../session-actions.js";
import type { PiRuntimePort } from "./runtime-port.js";
import { forkPiSession } from "./session-fork.js";
import {
  discoveredPiSessionId,
  piEngineId,
  piProviderKind,
  piSessionIdForSession
} from "./session-identity.js";

const inheritKeys = ["role", "sessionProfile", "turnExecutionProfiles"];

export class PiSessionActionsProvider implements SessionAgentActionsProvider {
  public readonly engineId = piEngineId;

  private readonly runtimePort: PiRuntimePort;
  private readonly now: () => string;

  public constructor(options: {
    runtimePort: PiRuntimePort;
    now?: () => string;
  }) {
    this.runtimePort = options.runtimePort;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public resolveDisplayedSessionId(
    input: SessionActionProviderContext
  ): string | undefined {
    return input.providerHandle?.providerKind === piProviderKind
      ? input.providerHandle.providerSessionId
      : undefined;
  }

  public async listAdditionalActions(
    input: SessionActionProviderContext
  ): Promise<SessionActionDescriptor[]> {
    const providerSessionId = resolveProviderSessionId(input);
    const workspaceId = resolveWorkspaceId(input);
    return [
      {
        action: "fork",
        label: "Fork",
        disabled: !providerSessionId || !workspaceId,
        reason: !providerSessionId
          ? "Fork is not available until the pi session exists."
          : !workspaceId
            ? "Fork is not available without a workspace context."
            : undefined
      }
    ];
  }

  public async prepareArchive(input: SessionActionProviderContext): Promise<void> {
    await this.runtimePort.releaseSession(input.sessionId);
  }

  public async runAction(
    input: SessionActionProviderContext &
      SessionActionOptions & { action: SessionActionKind }
  ): Promise<SessionActionResult | undefined> {
    if (input.action === "refresh") {
      await this.runtimePort.listSkills({ cwds: [], forceReload: true });
      return {
        action: "refresh",
        refreshed: true,
        details: "Reloaded the pi model catalog and skill list."
      };
    }

    if (input.action === "resume") {
      if (!resolveProviderSessionId(input)) {
        throw new Error("Resume is unavailable without a pi session id.");
      }
      // 调度器把 Worker 角色、模型配置与 cwd 作为 resume 的 metadata 传进来，
      // 不落到会话上就会一直沿用准备分支的身份。
      if (!input.preserveExecution) {
        await this.runtimePort.releaseSession(input.sessionId);
      }
      const cwd =
        input.cwd ??
        (typeof input.session?.metadata?.cwd === "string"
          ? input.session.metadata.cwd
          : undefined) ??
        (typeof input.indexEntry?.metadata?.cwd === "string"
          ? input.indexEntry.metadata.cwd
          : undefined);
      if (input.cwd || input.metadata) {
        await input.runtimeService.updateSessionMetadata(input.sessionId, {
          ...input.metadata,
          ...(input.cwd ? { cwd } : {})
        });
      }
      return {
        action: "resume",
        resumed: true
      };
    }

    if (input.action !== "fork") {
      return undefined;
    }

    const workspaceId = resolveWorkspaceId(input);
    if (!workspaceId) {
      throw new Error("Fork is unavailable without a workspace context.");
    }
    const sourcePiSessionId = resolveProviderSessionId(input);
    if (!sourcePiSessionId) {
      throw new Error("Fork is unavailable without a pi session id.");
    }
    const cwd =
      input.cwd ??
      (typeof input.session?.metadata?.cwd === "string"
        ? input.session.metadata.cwd
        : undefined) ??
      (typeof input.indexEntry?.metadata?.cwd === "string"
        ? input.indexEntry.metadata.cwd
        : undefined) ??
      (await this.runtimePort.sessionWorkingDirectory(input.sessionId));
    const childPiSessionId = randomUUID();
    const childSessionId = discoveredPiSessionId(childPiSessionId);
    const targetSessionDir = this.runtimePort.sessionDirectory(childSessionId);
    const fork = await forkPiSession({
      sourceSessionDir: this.runtimePort.sessionDirectory(input.sessionId),
      sourcePiSessionId,
      targetSessionDir,
      targetPiSessionId: childPiSessionId,
      targetCwd: cwd,
      ...(input.fromTurnId ? { fromTurnId: input.fromTurnId } : {}),
      now: this.now
    });
    const createdAt = this.now();
    const parentMetadata = {
      ...(input.indexEntry?.metadata ?? {}),
      ...(input.session?.metadata ?? {})
    };
    const inherited = Object.fromEntries(
      Object.entries(parentMetadata).filter(([key]) => inheritKeys.includes(key))
    );
    const title = input.session?.title ?? input.indexEntry?.title;
    const metadata = {
      ...inherited,
      providerKind: piProviderKind,
      providerSessionId: childPiSessionId,
      cwd,
      forkSourceSessionId: input.sessionId,
      ...(fork.forkSourceTurnId ? { forkSourceTurnId: fork.forkSourceTurnId } : {}),
      ...input.metadata
    };
    const conversationId =
      input.session?.conversationId ??
      input.indexEntry?.conversationId ??
      input.sessionId;
    await input.sessionIndexStore.upsertSession({
      workspaceId,
      session: {
        sessionId: childSessionId,
        conversationId,
        engineId: piEngineId,
        title,
        createdAt,
        updatedAt: createdAt,
        metadata
      },
      providerKind: piProviderKind,
      providerSessionId: childPiSessionId,
      source: "discovery"
    });
    await input.sessionIndexStore.upsertRelation({
      workspaceId,
      parentSessionId: input.sessionId,
      childSessionId,
      relationType: "fork",
      sourceTurnId: fork.forkSourceTurnId,
      createdAt
    });
    if (input.activateFork !== false) {
      await input.runtimeService.getWorkspaceRegistry()?.setLastActiveSelection({
        workspaceId,
        sessionId: childSessionId
      });
    }
    return {
      action: "fork",
      status: "forked",
      forkedSessionId: childSessionId,
      providerSessionId: childPiSessionId
    };
  }
}

export const resolveProviderSessionId = (
  input: SessionActionProviderContext
): string | undefined => {
  if (input.providerHandle?.providerKind === piProviderKind) {
    return input.providerHandle.providerSessionId;
  }
  const metadataProviderSessionId = input.session?.metadata?.providerSessionId;
  if (typeof metadataProviderSessionId === "string" && metadataProviderSessionId) {
    return metadataProviderSessionId;
  }
  const indexProviderSessionId = input.indexEntry?.providerSessionId;
  return indexProviderSessionId ?? piSessionIdForSession(input.sessionId);
};

const resolveWorkspaceId = (
  input: SessionActionProviderContext
): string | undefined =>
  input.indexEntry?.workspaceId ??
  (input.session?.conversationId
    ? input.runtimeService
        .getSnapshot()
        .conversations.find(
          (conversation) => conversation.conversationId === input.session?.conversationId
        )?.workspaceId
    : undefined);
