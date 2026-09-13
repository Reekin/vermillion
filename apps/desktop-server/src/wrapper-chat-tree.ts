import { randomUUID } from "node:crypto";
import type { Turn, ChatTreeSendInput, ChatTreeSendOperation, CommandEnvelope } from "@vermillion/shared";
import type { ChatTreeSnapshot, ChatTreeNodeSnapshot } from "./chat-tree-provider.js";
import type { SessionIndexStore } from "./session-index.js";
import type { SessionRuntimeService } from "./runtime-service.js";
import type { SessionReconciliationService } from "./session-discovery.js";
import { buildSessionWindowSnapshotFromPage } from "./session-window.js";

type SendOperationState = {
  operation: ChatTreeSendOperation;
  cancelRequested: boolean;
  completion?: Promise<void>;
  cleanup?: Promise<ChatTreeSendOperation>;
};

type TreeProjection = {
  tree: ChatTreeSnapshot;
  paths: Map<string, string[]>;
  turnsById: Map<string, Turn>;
};

type TreeLoadState = {
  generation: number;
  publishedGeneration?: number;
  published?: TreeProjection;
  loading?: Promise<void>;
  loadError?: unknown;
};

/** Fork membership and the viewing cursor belong to the wrapper, independently of running turns. */
export class WrapperChatTreeService {
  private readonly loaded = new Set<string>();
  private readonly loading = new Map<string, Promise<void>>();
  private readonly trees = new Map<string, TreeLoadState>();
  private readonly operations = new Map<string, SendOperationState>();
  private readonly unsubscribe: () => void;

  public constructor(private readonly options: {
    runtimeService: SessionRuntimeService;
    sessionIndexStore: SessionIndexStore;
    reconciliation: SessionReconciliationService;
    fork: (sessionId: string, turnId: string) => Promise<string>;
  }) {
    this.unsubscribe = options.runtimeService.subscribe(({ event }) => {
      if (event.type === "turn.completed") {
        this.changed(event.sessionId);
        return;
      }
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

  private treeState(sessionId: string): TreeLoadState {
    const treeId = this.options.sessionIndexStore.getTreeId(sessionId);
    let state = this.trees.get(treeId);
    if (!state) {
      state = { generation: 0 };
      this.trees.set(treeId, state);
    }
    return state;
  }

  public invalidate(sessionId: string): void {
    const index = this.options.sessionIndexStore;
    const state = this.treeState(sessionId);
    state.generation += 1;
    state.loadError = undefined;
    for (const memberId of index.getTreeMembers(sessionId)) {
      this.loaded.delete(memberId);
    }
  }

  private async loadMember(sessionId: string): Promise<void> {
    while (!this.loaded.has(sessionId)) {
      const existing = this.loading.get(sessionId);
      if (existing) {
        await existing;
        continue;
      }
      const state = this.treeState(sessionId);
      const generation = state.generation;
      const task = (async () => {
        const entry = this.options.sessionIndexStore.getEntry(sessionId);
        const loaded = await this.options.reconciliation.ensureSessionLoaded(
          sessionId,
          entry?.providerSessionId
            ? {
                force: false,
                requireFull: true,
                isCancelled: () => state.generation !== generation
              }
            : { force: false }
        );
        if (!loaded) {
          if (this.options.sessionIndexStore.getEntry(sessionId)?.archivedAt) return;
          throw new Error(`Unable to load tree member: ${sessionId}`);
        }
        if (this.treeState(sessionId) === state && state.generation === generation) {
          this.loaded.add(sessionId);
        }
      })();
      this.loading.set(sessionId, task);
      try {
        await task;
      } finally {
        if (this.loading.get(sessionId) === task) this.loading.delete(sessionId);
      }
      if (this.options.sessionIndexStore.getEntry(sessionId)?.archivedAt && !this.loaded.has(sessionId) &&
        this.treeState(sessionId) === state && state.generation === generation) return;
    }
  }

  private async loadTree(sessionId: string, generation: number): Promise<TreeProjection | undefined> {
    const index = this.options.sessionIndexStore;
    while (true) {
      if (this.treeState(sessionId).generation !== generation) return undefined;
      const members = index.getTreeMembers(sessionId);
      if (members.some((id) => index.getEntry(id)?.archivedAt)) {
        // Ancestors borrow surviving histories before those members load themselves.
        for (const id of members) await this.loadMember(id);
      } else {
        await Promise.all(members.map((id) => this.loadMember(id)));
      }
      if (this.treeState(sessionId).generation !== generation) return undefined;
      const current = index.getTreeMembers(sessionId);
      if (current.every((id) => this.loaded.has(id) || index.getEntry(id)?.archivedAt)) {
        return this.buildProjection(sessionId);
      }
    }
  }

  private startTreeLoad(sessionId: string, state: TreeLoadState): Promise<void> {
    if (state.loading) return state.loading;
    const generation = state.generation;
    const hadPublished = Boolean(state.published);
    state.loading = this.loadTree(sessionId, generation)
      .then(async (projection) => {
        if (!projection || state.generation !== generation) return;
        state.published = projection;
        state.publishedGeneration = generation;
        state.loadError = undefined;
        if (hadPublished) {
          await this.reportTreeRefresh(sessionId, { status: "ready" });
          this.changed(sessionId);
        }
      })
      .catch(async (error) => {
        if (state.generation === generation) {
          state.loadError = error;
          if (state.published) {
            await this.reportTreeRefresh(sessionId, {
              status: "failed",
              message: error instanceof Error ? error.message : String(error)
            });
            this.changed(sessionId);
          }
        }
      })
      .finally(() => {
        state.loading = undefined;
        if (state.generation !== generation) void this.startTreeLoad(sessionId, state);
      });
    return state.loading;
  }

  private async reportTreeRefresh(
    sessionId: string,
    chatTreeRefresh: { status: "ready" | "failed"; message?: string }
  ): Promise<void> {
    await Promise.all(this.options.sessionIndexStore.getTreeMembers(sessionId).map(async (memberId) => {
      try {
        await this.options.runtimeService.updateSessionMetadata(memberId, { chatTreeRefresh });
      } catch (error) {
        console.warn("[vermillion] Failed to persist chat tree refresh status", {
          sessionId: memberId,
          status: chatTreeRefresh.status,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }));
  }

  private async loadPublishedTreeChanges(sessionId: string): Promise<void> {
    const index = this.options.sessionIndexStore;
    while (true) {
      const pendingTargets = new Set([...this.operations.values()]
        .map((state) => state.operation)
        .filter((operation) => operation.status !== "sent" && operation.targetSessionId)
        .map((operation) => operation.targetSessionId!));
      const members = index.getTreeMembers(sessionId);
      const missing = members.filter((id) =>
        !this.loaded.has(id) && !pendingTargets.has(id) && !index.getEntry(id)?.archivedAt);
      if (missing.length === 0) return;
      await Promise.all(missing.map((id) => this.loadMember(id)));
    }
  }

  private buildProjection(sessionId: string): TreeProjection {
    const { runtimeService, sessionIndexStore: index } = this.options;
    const treeId = index.getTreeId(sessionId);
    const treeMembers = index.getTreeMembers(sessionId);
    const members = treeMembers.filter((id) => this.loaded.has(id));
    const snapshot = runtimeService.getSnapshot();
    const relations = index.listRelations();
    const paths = new Map<string, string[]>();
    const nodes: ChatTreeNodeSnapshot[] = [];
    const turnsById = new Map<string, Turn>();
    const sessionsById = new Map(snapshot.sessions.map((session) => [session.sessionId, session]));
    const forkByChild = new Map(relations
      .filter((relation) => relation.relationType === "fork")
      .map((relation) => [relation.childSessionId, relation]));
    const turnsBySessionId = new Map<string, Turn[]>();
    for (const turn of snapshot.turns) {
      if (!members.includes(turn.sessionId)) continue;
      const turns = turnsBySessionId.get(turn.sessionId) ?? [];
      turns.push(turn);
      turnsBySessionId.set(turn.sessionId, turns);
    }
    for (const turns of turnsBySessionId.values()) {
      turns.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    }
    const questionByTurnId = new Map<string, string>();
    for (const block of snapshot.messageBlocks) {
      if (block.role === "user" && block.text && !questionByTurnId.has(block.turnId)) {
        questionByTurnId.set(block.turnId, block.text);
      }
    }
    for (const memberId of members) {
      const relation = forkByChild.get(memberId);
      const parentPath = relation ? paths.get(relation.parentSessionId) ?? [] : [];
      const sourceIndex = relation?.sourceTurnId ? parentPath.indexOf(relation.sourceTurnId) : -1;
      // Archived history can end before its original fork point after a descendant reforks earlier.
      const prefixEnd = sourceIndex < 0 && index.getEntry(memberId)?.archivedAt
        ? parentPath.length : sourceIndex + 1;
      const prefix = relation?.sourceTurnId
        ? parentPath.slice(0, prefixEnd) : [];
      const turns = turnsBySessionId.get(memberId) ?? [];
      let parentNodeId = prefix.at(-1);
      const readTurnIds = new Set(index.getEntry(memberId)?.readTurnIds);
      for (const turn of turns) {
        const question = questionByTurnId.get(turn.turnId);
        nodes.push({
          nodeId: turn.turnId, turnId: turn.turnId, parentNodeId,
          label: question?.slice(0, 80) || turn.turnId,
          order: nodes.length, isCurrent: false,
          unread: turn.status === "completed" && !readTurnIds.has(turn.turnId),
          status: turn.status === "completed" ? "completed" : "pending"
        });
        turnsById.set(turn.turnId, turn);
        parentNodeId = turn.turnId;
      }
      paths.set(memberId, [...prefix, ...turns.map((turn) => turn.turnId)]);
    }
    // Archived sessions supply shared history, but never a selectable/sendable path.
    for (const memberId of members) {
      if (index.getEntry(memberId)?.archivedAt) paths.delete(memberId);
    }
    const retained = new Set([...paths.values()].flat());
    const visibleNodes = nodes.filter((node) => retained.has(node.nodeId));
    const parentIds = new Set(visibleNodes.map((node) => node.parentNodeId));
    const forkIds = new Set(relations.filter((relation) => relation.relationType === "fork")
      .map((relation) => relation.childSessionId));
    const complete = treeMembers.every((id) => this.loaded.has(id));
    for (const node of visibleNodes) {
      const owner = turnsById.get(node.nodeId)!.sessionId;
      Object.assign(node, { sessionId: owner, canArchive: complete && !parentIds.has(node.nodeId) &&
        forkIds.has(owner) && !index.getEntry(owner)?.archivedAt });
    }
    const view = index.getTreeView(treeId);
    const stored = view && paths.has(view.sessionId) ? view : undefined;
    const currentSessionId = stored?.sessionId ?? (paths.has(sessionId) ? sessionId : paths.keys().next().value ?? treeId);
    // Legacy views did not distinguish automatic cursors from explicit jumps; resume tip following.
    const currentNodeId = stored?.followTip === false ? stored.nodeId : paths.get(currentSessionId)?.at(-1);
    const currentPath = paths.get(currentSessionId) ?? [];
    const visibleTurnIds = currentNodeId ? currentPath.slice(0, currentPath.indexOf(currentNodeId) + 1) : [];
    const windows = members.flatMap((memberId) => {
      const memberSession = sessionsById.get(memberId);
      if (!memberSession) return [];
      return [buildSessionWindowSnapshotFromPage({
        ...snapshot,
        sessionId: memberId,
        session: memberSession,
        conversation: snapshot.conversations.find((item) =>
          item.conversationId === memberSession.conversationId)!,
        turns: (turnsBySessionId.get(memberId) ?? []).filter((turn) => retained.has(turn.turnId)),
        sessionRelations: snapshot.sessionRelations.filter((item) =>
          item.parentSessionId === memberId || item.childSessionId === memberId),
        participants: snapshot.participants.filter((item) =>
          item.conversationId === memberSession.conversationId),
        cursor: runtimeService.getRevision() === "initial" ? undefined : runtimeService.getRevision(),
        hasOlder: false,
        hasNewer: false,
        replaceSessionHistory: true
      })];
    });
    const tree: ChatTreeSnapshot = {
      sessionId, treeId, currentSessionId, memberSessionIds: treeMembers,
      engineId: snapshot.sessions.find((item) => item.sessionId === treeId)!.engineId,
      supportsJump: true, currentNodeId, visibleTurnIds, visibleNodeIds: visibleTurnIds,
      nodes: visibleNodes.map((node) => ({ ...node, isCurrent: node.nodeId === currentNodeId })),
      windows, fetchedAt: new Date().toISOString()
    };
    return { tree, paths, turnsById };
  }

  private publishedProjection(sessionId: string): TreeProjection {
    const published = this.treeState(sessionId).published;
    if (!published) throw new Error(`Chat tree is not loaded: ${sessionId}`);
    return published;
  }

  private applyPublishedView(
    sessionId: string,
    view: { sessionId: string; nodeId?: string; followTip?: boolean }
  ): void {
    const projection = this.publishedProjection(sessionId);
    const path = projection.paths.get(view.sessionId) ?? [];
    const currentNodeId = view.followTip === false ? view.nodeId : path.at(-1);
    const visibleTurnIds = currentNodeId
      ? path.slice(0, path.indexOf(currentNodeId) + 1)
      : [];
    projection.tree = {
      ...projection.tree,
      currentSessionId: view.sessionId,
      currentNodeId,
      visibleTurnIds,
      visibleNodeIds: visibleTurnIds,
      nodes: projection.tree.nodes.map((node) => ({
        ...node,
        isCurrent: node.nodeId === currentNodeId
      }))
    };
  }

  public async get(sessionId: string): Promise<ChatTreeSnapshot> {
    await this.options.sessionIndexStore.ready();
    const index = this.options.sessionIndexStore;
    while (true) {
      const state = this.treeState(sessionId);
      if (state.publishedGeneration !== state.generation) {
        if (state.loadError && !state.loading && state.published) return state.published.tree;
        const loading = this.startTreeLoad(sessionId, state);
        if (!state.published) {
          await loading;
          if (!state.published) throw state.loadError ?? new Error(`Unable to load tree: ${sessionId}`);
        } else {
          return state.published.tree;
        }
      }
      await this.loadPublishedTreeChanges(sessionId);
      if (this.treeState(sessionId) !== state || state.publishedGeneration !== state.generation) continue;
      const members = index.getTreeMembers(sessionId);
      for (const id of members.filter((id) => !this.loaded.has(id) && !this.loading.has(id))) {
        void this.loadMember(id).then(() => this.changed(sessionId)).catch(() => {});
      }
      const projection = this.buildProjection(sessionId);
      state.published = projection;
      const tree = projection.tree;
      if (!this.options.sessionIndexStore.getTreeView(sessionId)) {
        const view = {
          sessionId: tree.currentSessionId!, nodeId: tree.currentNodeId, followTip: true
        };
        await this.options.sessionIndexStore.setTreeView(sessionId, view);
        this.applyPublishedView(sessionId, view);
      }
      return state.published.tree;
    }
  }

  public async selectSession(sessionId: string): Promise<void> {
    await this.get(sessionId);
    const { paths } = this.publishedProjection(sessionId);
    const view = {
      sessionId, nodeId: paths.get(sessionId)?.at(-1), followTip: true
    };
    await this.options.sessionIndexStore.setTreeView(sessionId, view);
    this.applyPublishedView(sessionId, view);
    this.options.runtimeService.notifyChatTreeChanged(sessionId, paths.get(sessionId) ?? []);
  }

  public async getNodeTarget(sessionId: string, nodeId: string): Promise<{ sessionId: string; canArchive: boolean }> {
    await this.options.sessionIndexStore.ready();
    await this.get(sessionId);
    const { tree, turnsById } = this.publishedProjection(sessionId);
    if (!tree.nodes.some((node) => node.nodeId === nodeId)) throw new Error(`Unknown tree node: ${nodeId}`);
    const owner = turnsById.get(nodeId)!.sessionId;
    const index = this.options.sessionIndexStore;
    return { sessionId: owner, canArchive: !index.getEntry(owner)?.archivedAt &&
      index.listRelations().some((relation) => relation.relationType === "fork" && relation.childSessionId === owner) &&
      !tree.nodes.some((node) => node.parentNodeId === nodeId) };
  }

  public async archiveBranch(sessionId: string, nodeId: string, archive: (memberId: string) => Promise<unknown>): Promise<{ archived: true }> {
    const target = await this.getNodeTarget(sessionId, nodeId);
    if (!target.canArchive) throw new Error("Only a terminal fork node can be archived.");
    await archive(target.sessionId);
    for (const [operationId, state] of this.operations) {
      if (state.operation.targetSessionId === target.sessionId) this.operations.delete(operationId);
    }
    const index = this.options.sessionIndexStore;
    if (index.getTreeView(sessionId)?.sessionId === target.sessionId) {
      const { tree } = this.publishedProjection(sessionId);
      const view = {
        sessionId: tree.currentSessionId!, nodeId: tree.currentNodeId, followTip: true
      };
      await index.setTreeView(sessionId, view);
      this.applyPublishedView(sessionId, view);
    }
    this.changed(sessionId);
    return { archived: true };
  }

  public async jump(sessionId: string, nodeId: string): Promise<{ jumped: boolean }> {
    // The graph is already loaded when a user picks a node; no engine operation belongs here.
    const { tree, paths, turnsById } = this.publishedProjection(sessionId);
    const member = this.resolveSendSource(tree.currentSessionId!, nodeId, paths, turnsById);
    const view = { sessionId: member, nodeId, followTip: false };
    await this.options.sessionIndexStore.setTreeView(sessionId, view);
    this.applyPublishedView(sessionId, view);
    return { jumped: true };
  }

  public async prepareSend(sessionId: string, nodeId?: string): Promise<{ sessionId: string }> {
    await this.get(sessionId);
    const projection = this.publishedProjection(sessionId);
    const { tree, paths, turnsById } = projection;
    const target = nodeId ?? tree.currentNodeId;
    if (target && turnsById.get(target)?.status !== "completed") {
      throw new Error("Wait for this turn to finish before branching.");
    }
    let member = nodeId ? this.resolveSendSource(sessionId, nodeId, paths, turnsById) : tree.currentSessionId!;
    if (target && !paths.get(member)?.includes(target)) {
      member = this.resolveSendSource(sessionId, target, paths, turnsById);
    }
    if (target && paths.get(member)?.at(-1) !== target) {
      member = await this.options.fork(member, target);
      await this.loadMember(member);
      const state = this.treeState(sessionId);
      state.published = this.buildProjection(sessionId);
      state.publishedGeneration = state.generation;
    }
    const view = { sessionId: member, nodeId: target, followTip: true };
    await this.options.sessionIndexStore.setTreeView(sessionId, view);
    this.applyPublishedView(sessionId, view);
    return { sessionId: member };
  }

  public async markRead(sessionId: string, nodeId: string): Promise<{ readNodeIds: string[] }> {
    await this.get(sessionId);
    const { paths, turnsById } = this.publishedProjection(sessionId);
    const path = [...paths.values()].find((ids) => ids.includes(nodeId));
    if (!path) throw new Error(`Unknown tree node: ${nodeId}`);
    const turns = path.slice(0, path.indexOf(nodeId) + 1)
      .map((id) => turnsById.get(id)!)
      .filter((turn) => turn.status === "completed");
    if (await this.options.sessionIndexStore.markTurnsRead(turns)) this.changed(sessionId);
    return { readNodeIds: turns.map((turn) => turn.turnId) };
  }

  private resolveSendSource(sessionId: string, nodeId: string, paths: Map<string, string[]>, turnsById: Map<string, Turn>): string {
    if (paths.get(sessionId)?.includes(nodeId)) return sessionId;
    const source = turnsById.get(nodeId)?.sessionId;
    if (!source) throw new Error(`Unknown tree node: ${nodeId}`);
    if (paths.has(source)) return source;
    const surviving = [...paths].find(([, ids]) => ids.includes(nodeId))?.[0];
    if (!surviving) throw new Error(`Unknown tree node: ${nodeId}`);
    return surviving;
  }

  private changed(sessionId: string): void {
    const view = this.options.sessionIndexStore.getTreeView(sessionId);
    this.options.runtimeService.notifyChatTreeChanged(sessionId, view?.nodeId ? [view.nodeId] : []);
  }

  public listOperations(sessionId: string): ChatTreeSendOperation[] {
    const index = this.options.sessionIndexStore;
    return structuredClone([...this.operations.values()]
      .filter((state) => !state.cancelRequested || state.operation.cleanupPending)
      .map((state) => state.operation)
      .filter((operation) => index.getTreeId(operation.sessionId) === index.getTreeId(sessionId)));
  }

  public submit(input: ChatTreeSendInput, send: TreeSend): ChatTreeSendOperation {
    const operation: ChatTreeSendOperation = { ...structuredClone(input), operationId: randomUUID(), status: "creating" };
    const state: SendOperationState = { operation, cancelRequested: false };
    this.operations.set(operation.operationId, state);
    return this.start(state, send);
  }

  public retry(operationId: string, send: TreeSend): ChatTreeSendOperation {
    const state = this.operations.get(operationId);
    if (!state) throw new Error(`Unknown send operation: ${operationId}`);
    const operation = state.operation;
    if (operation.status !== "failed") return structuredClone(operation);
    if (operation.cleanupPending) throw new Error("Finish removing this cancelled send before retrying.");
    state.cancelRequested = false;
    operation.status = "creating";
    delete operation.error;
    return this.start(state, send);
  }

  public async cancel(operationId: string, action: "cancel" | "remove", cleanup: TreeCancelCleanup): Promise<ChatTreeSendOperation> {
    const state = this.operations.get(operationId);
    if (!state) throw new Error(`Unknown send operation: ${operationId}`);
    if (state.cleanup) return state.cleanup;
    const operation = state.operation;
    if (action === "cancel" && operation.status !== "creating" && operation.status !== "sending" && operation.status !== "sent") {
      throw new Error("Only a send in progress can be cancelled.");
    }
    if (action === "remove" && operation.status !== "failed") {
      throw new Error("Only a failed send can be removed.");
    }
    const recovered = structuredClone(operation);
    state.cancelRequested = true;
    this.changed(operation.sessionId);
    const task = (async () => {
      await state.completion;
      try {
        if (operation.turnId && operation.targetSessionId) {
          await cleanup.interrupt(operation.targetSessionId, operation.turnId);
        } else if (operation.targetSessionId) {
          await cleanup.archive(operation.targetSessionId);
        }
        this.operations.delete(operationId);
      } catch (error) {
        operation.status = "failed";
        operation.cleanupPending = true;
        operation.error = `Branch cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
        this.changed(operation.sessionId);
        throw error;
      }
      this.changed(operation.sessionId);
      return recovered;
    })();
    state.cleanup = task;
    try {
      return await task;
    } catch (error) {
      state.cleanup = undefined;
      throw error;
    }
  }

  private start(state: SendOperationState, send: TreeSend): ChatTreeSendOperation {
    const operation = state.operation;
    const snapshot = structuredClone(operation);
    this.changed(operation.sessionId);
    state.completion = this.run(state, send);
    return snapshot;
  }

  private async run(state: SendOperationState, send: TreeSend): Promise<void> {
    const operation = state.operation;
    try {
      if (!operation.targetSessionId) {
        await this.get(operation.sessionId);
        if (state.cancelRequested) return;
        const { paths, turnsById } = this.publishedProjection(operation.sessionId);
        if (turnsById.get(operation.nodeId)?.status !== "completed") {
          throw new Error("Wait for this turn to finish before branching.");
        }
        const source = this.resolveSendSource(operation.sessionId, operation.nodeId, paths, turnsById);
        operation.targetSessionId = await this.options.fork(source, operation.nodeId);
        this.changed(operation.sessionId);
      }
      if (state.cancelRequested) return;
      await this.loadMember(operation.targetSessionId);
      if (state.cancelRequested) return;
      operation.status = "sending";
      this.changed(operation.sessionId);
      const receipt = await send({ commandId: randomUUID(), command: {
        type: "sendUserMessage", sessionId: operation.targetSessionId,
        messageId: randomUUID(), content: operation.content, attachments: structuredClone(operation.attachments),
        execution: structuredClone(operation.execution)
      } });
      if (!receipt.accepted || !receipt.turnId) throw new Error(receipt.error?.message || "Branch message was not accepted.");
      operation.turnId = receipt.turnId;
      if (state.cancelRequested) return;
      operation.status = "sent";
    } catch (error) {
      if (!state.cancelRequested) {
        operation.status = "failed";
        operation.error = error instanceof Error ? error.message : String(error);
      }
    }
    this.changed(operation.sessionId);
  }
}

type TreeSend = (command: CommandEnvelope) => Promise<Pick<import("./runtime-types.js").CommandReceipt, "accepted" | "turnId" | "error">>;
type TreeCancelCleanup = {
  archive: (sessionId: string) => Promise<unknown>;
  interrupt: (sessionId: string, turnId: string) => Promise<unknown>;
};
