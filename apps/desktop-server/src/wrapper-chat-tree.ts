import { randomUUID } from "node:crypto";
import type { Turn, ChatTreeSendInput, ChatTreeSendOperation, CommandEnvelope } from "@vermillion/shared";
import type { ChatTreeSnapshot, ChatTreeNodeSnapshot } from "./chat-tree-provider.js";
import type { SessionIndexStore } from "./session-index.js";
import type { SessionRuntimeService } from "./runtime-service.js";
import type { SessionReconciliationService } from "./session-discovery.js";
import { buildSessionWindowSnapshotFromPage } from "./session-window.js";

/** Fork membership and the viewing cursor belong to the wrapper, independently of running turns. */
export class WrapperChatTreeService {
  private readonly loaded = new Set<string>();
  private readonly loading = new Map<string, Promise<void>>();
  private readonly operations = new Map<string, ChatTreeSendOperation>();
  private readonly unsubscribe: () => void;

  public constructor(private readonly options: {
    runtimeService: SessionRuntimeService;
    sessionIndexStore: SessionIndexStore;
    reconciliation: SessionReconciliationService;
    fork: (sessionId: string, turnId: string) => Promise<string>;
  }) {
    this.unsubscribe = options.runtimeService.subscribe(({ event }) => {
      if (event.type !== "turn.started") return;
      const index = options.sessionIndexStore;
      const treeId = index.getTreeId(event.sessionId);
      const view = index.getTreeView(treeId);
      if (view?.sessionId === event.sessionId && view.followTip !== false) {
        void index.setTreeView(treeId, { sessionId: event.sessionId, nodeId: event.turnId, followTip: true });
      }
    });
  }

  public dispose(): void { this.unsubscribe(); }

  public async setMode(sessionId: string, mode: import("@vermillion/shared").ThinkMode) {
    await this.options.sessionIndexStore.setTreeMode(sessionId, mode);
    return { mode };
  }

  private async loadMember(sessionId: string): Promise<void> {
    if (this.loaded.has(sessionId)) return;
    const existing = this.loading.get(sessionId);
    if (existing) return existing;
    const task = (async () => {
      const session = this.options.runtimeService.getSession(sessionId);
      const entry = this.options.sessionIndexStore.getEntry(sessionId);
      const force = Boolean(session && entry?.providerSessionId &&
        session.status !== "running" && session.status !== "awaiting_approval");
      const loaded = await this.options.reconciliation.ensureSessionLoaded(sessionId, { force });
      if (!loaded) throw new Error(`Unable to load tree member: ${sessionId}`);
      this.loaded.add(sessionId);
    })().finally(() => this.loading.delete(sessionId));
    this.loading.set(sessionId, task);
    return task;
  }

  private project(sessionId: string) {
    const { runtimeService, sessionIndexStore: index } = this.options;
    const treeId = index.getTreeId(sessionId);
    const members = index.getTreeMembers(sessionId).filter((id) => this.loaded.has(id));
    const snapshot = runtimeService.getSnapshot();
    const relations = index.listRelations();
    const paths = new Map<string, string[]>();
    const nodes: ChatTreeNodeSnapshot[] = [];
    const turnsById = new Map<string, Turn>();
    const windows = members.map((memberId) => {
      const session = snapshot.sessions.find((item) => item.sessionId === memberId)!;
      const relation = relations.find((item) => item.relationType === "fork" && item.childSessionId === memberId);
      const parentPath = relation ? paths.get(relation.parentSessionId) ?? [] : [];
      const prefix = relation?.sourceTurnId
        ? parentPath.slice(0, parentPath.indexOf(relation.sourceTurnId) + 1) : [];
      const turns = snapshot.turns.filter((turn) => turn.sessionId === memberId)
        .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
      let parentNodeId = prefix.at(-1);
      for (const turn of turns) {
        const question = snapshot.messageBlocks.find((block) =>
          block.turnId === turn.turnId && block.role === "user" && block.text)?.text;
        nodes.push({
          nodeId: turn.turnId, turnId: turn.turnId, parentNodeId,
          label: question?.slice(0, 80) || turn.turnId,
          order: nodes.length, isCurrent: false,
          status: turn.status === "completed" ? "completed" : "pending"
        });
        turnsById.set(turn.turnId, turn);
        parentNodeId = turn.turnId;
      }
      paths.set(memberId, [...prefix, ...turns.map((turn) => turn.turnId)]);
      return buildSessionWindowSnapshotFromPage({
        ...snapshot,
        sessionId: memberId,
        session,
        conversation: snapshot.conversations.find((item) => item.conversationId === session.conversationId)!,
        turns,
        sessionRelations: snapshot.sessionRelations.filter((item) =>
          item.parentSessionId === memberId || item.childSessionId === memberId),
        participants: snapshot.participants.filter((item) => item.conversationId === session.conversationId),
        cursor: runtimeService.getRevision() === "initial" ? undefined : runtimeService.getRevision(),
        hasOlder: false, hasNewer: false
      });
    });
    const byActivity = [...members].sort((left, right) => {
      const sessions = snapshot.sessions;
      return sessions.find((item) => item.sessionId === right)!.updatedAt
        .localeCompare(sessions.find((item) => item.sessionId === left)!.updatedAt);
    });
    const view = index.getTreeView(treeId);
    const stored = view && paths.has(view.sessionId) ? view : undefined;
    const currentSessionId = stored?.sessionId ?? byActivity[0]!;
    // Legacy views did not distinguish automatic cursors from explicit jumps; resume tip following.
    const currentNodeId = stored?.followTip === false ? stored.nodeId : paths.get(currentSessionId)?.at(-1);
    const currentPath = paths.get(currentSessionId) ?? [];
    const visibleTurnIds = currentNodeId ? currentPath.slice(0, currentPath.indexOf(currentNodeId) + 1) : [];
    const tree: ChatTreeSnapshot = {
      sessionId, treeId, currentSessionId, memberSessionIds: members,
      thinkMode: index.getTreeMode(treeId),
      engineId: snapshot.sessions.find((item) => item.sessionId === treeId)!.engineId,
      supportsJump: true, currentNodeId, visibleTurnIds, visibleNodeIds: visibleTurnIds,
      nodes: nodes.map((node) => ({ ...node, isCurrent: node.nodeId === currentNodeId })),
      windows, fetchedAt: new Date().toISOString()
    };
    return { tree, paths, turnsById, byActivity };
  }

  public async get(sessionId: string): Promise<ChatTreeSnapshot> {
    await this.options.sessionIndexStore.ready();
    const members = this.options.sessionIndexStore.getTreeMembers(sessionId);
    if (!members.some((id) => this.loaded.has(id))) {
      await Promise.all(members.map((id) => this.loadMember(id)));
    } else {
      for (const id of members.filter((id) => !this.loaded.has(id) && !this.loading.has(id))) {
        void this.loadMember(id).then(() => this.changed(sessionId)).catch(() => {});
      }
    }
    const { tree } = this.project(sessionId);
    if (!this.options.sessionIndexStore.getTreeView(sessionId)) {
      await this.options.sessionIndexStore.setTreeView(sessionId, {
        sessionId: tree.currentSessionId!, nodeId: tree.currentNodeId, followTip: true
      });
    }
    return tree;
  }

  public async selectSession(sessionId: string): Promise<void> {
    await this.get(sessionId);
    const { paths } = this.project(sessionId);
    await this.options.sessionIndexStore.setTreeView(sessionId, {
      sessionId, nodeId: paths.get(sessionId)?.at(-1), followTip: true
    });
    this.options.runtimeService.notifyChatTreeChanged(sessionId, paths.get(sessionId) ?? []);
  }

  public async jump(sessionId: string, nodeId: string): Promise<{ jumped: boolean }> {
    // The graph is already loaded when a user picks a node; no engine operation belongs here.
    const { paths, byActivity } = this.project(sessionId);
    const member = byActivity.find((id) => paths.get(id)?.at(-1) === nodeId) ??
      byActivity.find((id) => paths.get(id)?.includes(nodeId));
    if (!member) throw new Error(`Unknown tree node: ${nodeId}`);
    await this.options.sessionIndexStore.setTreeView(sessionId, { sessionId: member, nodeId, followTip: false });
    return { jumped: true };
  }

  public async prepareSend(sessionId: string, nodeId?: string): Promise<{ sessionId: string }> {
    await this.get(sessionId);
    const { tree, paths, turnsById, byActivity } = this.project(sessionId);
    const target = nodeId ?? tree.currentNodeId;
    if (target && turnsById.get(target)?.status !== "completed") {
      throw new Error("Wait for this turn to finish before branching.");
    }
    let member = tree.currentSessionId!;
    if (target && !paths.get(member)?.includes(target)) {
      member = byActivity.find((id) => paths.get(id)?.includes(target))!;
    }
    if (target && paths.get(member)?.at(-1) !== target) {
      member = await this.options.fork(member, target);
      await this.loadMember(member);
    }
    const view = { sessionId: member, nodeId: target, followTip: true };
    await this.options.sessionIndexStore.setTreeView(sessionId, view);
    return { sessionId: member };
  }

  private changed(sessionId: string): void {
    const view = this.options.sessionIndexStore.getTreeView(sessionId);
    this.options.runtimeService.notifyChatTreeChanged(sessionId, view?.nodeId ? [view.nodeId] : []);
  }

  public listOperations(sessionId: string): ChatTreeSendOperation[] {
    const index = this.options.sessionIndexStore;
    return structuredClone([...this.operations.values()].filter((operation) =>
      index.getTreeId(operation.sessionId) === index.getTreeId(sessionId)));
  }

  public submit(input: ChatTreeSendInput, send: TreeSend): ChatTreeSendOperation {
    const operation: ChatTreeSendOperation = { ...structuredClone(input), operationId: randomUUID(), status: "creating" };
    this.operations.set(operation.operationId, operation);
    return this.start(operation, send);
  }

  public retry(operationId: string, send: TreeSend): ChatTreeSendOperation {
    const operation = this.operations.get(operationId);
    if (!operation) throw new Error(`Unknown send operation: ${operationId}`);
    if (operation.status !== "failed") return structuredClone(operation);
    operation.status = "creating";
    delete operation.error;
    return this.start(operation, send);
  }

  private start(operation: ChatTreeSendOperation, send: TreeSend): ChatTreeSendOperation {
    const snapshot = structuredClone(operation);
    this.changed(operation.sessionId);
    void this.run(operation, send);
    return snapshot;
  }

  private async run(operation: ChatTreeSendOperation, send: TreeSend): Promise<void> {
    try {
      if (!operation.targetSessionId) {
        await this.get(operation.sessionId);
        const { paths, turnsById, byActivity } = this.project(operation.sessionId);
        if (turnsById.get(operation.nodeId)?.status !== "completed") {
          throw new Error("Wait for this turn to finish before branching.");
        }
        const source = byActivity.find((id) => paths.get(id)?.includes(operation.nodeId));
        if (!source) throw new Error(`Unknown tree node: ${operation.nodeId}`);
        operation.targetSessionId = await this.options.fork(source, operation.nodeId);
        this.changed(operation.sessionId);
      }
      await this.loadMember(operation.targetSessionId);
      operation.status = "sending";
      this.changed(operation.sessionId);
      const receipt = await send({ commandId: randomUUID(), command: {
        type: "sendUserMessage", sessionId: operation.targetSessionId,
        messageId: randomUUID(), content: operation.content, attachments: structuredClone(operation.attachments),
        execution: structuredClone(operation.execution), thinkMode: operation.thinkMode
      } });
      if (!receipt.accepted || !receipt.turnId) throw new Error("Branch message was not accepted.");
      operation.turnId = receipt.turnId;
      operation.status = "sent";
    } catch (error) {
      operation.status = "failed";
      operation.error = error instanceof Error ? error.message : String(error);
    }
    this.changed(operation.sessionId);
  }
}

type TreeSend = (command: CommandEnvelope) => Promise<{ accepted: boolean; turnId?: string }>;
