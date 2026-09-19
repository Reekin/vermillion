import { randomUUID } from "node:crypto";
import type { Turn, ChatTreeSendInput, ChatTreeSendOperation, CommandEnvelope } from "@vermillion/shared";
import type { ChatTreeSnapshot, ChatTreeNodeSnapshot } from "./chat-tree-provider.js";
import type { SessionIndexStore } from "./session-index.js";
import type { SessionRuntimeService } from "./runtime-service.js";
import type { SessionReconciliationService } from "./session-discovery.js";
import type { CapabilityRegistry } from "./capability-registry.js";
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

/** `tree` 只给树结构，`path` 给当前查看路径的位置与正文窗口。 */
export type ChatTreeScope = "tree" | "path";

type TreeLoad = {
  controller: AbortController;
  promise: Promise<void>;
  /** 本代加载完成的成员，完成后整体成为当前投影的成员集合。 */
  members: Set<string>;
};

type TreeState = {
  /** 当前投影使用的成员集合，刷新期间保持上一代结果可读。 */
  members: Set<string>;
  load?: TreeLoad;
  published?: TreeProjection;
  reload: boolean;
  error?: unknown;
};

/** Fork membership and the viewing cursor belong to the wrapper, independently of running turns. */
export class WrapperChatTreeService {
  private readonly trees = new Map<string, TreeState>();
  private readonly operations = new Map<string, SendOperationState>();
  private readonly unsubscribe: () => void;

  public constructor(private readonly options: {
    runtimeService: SessionRuntimeService;
    sessionIndexStore: SessionIndexStore;
    reconciliation: SessionReconciliationService;
    capabilities: CapabilityRegistry;
    /** 诊断通道：记录被失效中止的一代树加载。 */
    logDiagnostic?: (input: {
      message: string;
      sessionId?: string;
      context?: Record<string, unknown>;
    }) => void;
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

  public dispose(): void {
    this.unsubscribe();
    for (const state of this.trees.values()) state.load?.controller.abort();
  }

  private treeState(sessionId: string): TreeState {
    const treeId = this.options.sessionIndexStore.getTreeId(sessionId);
    let state = this.trees.get(treeId);
    if (!state) {
      state = { members: new Set(), reload: false };
      this.trees.set(treeId, state);
    }
    return state;
  }

  /** 历史失效：中止本代加载，保留已发布结果，并立即以新一代重建。 */
  public invalidate(sessionId: string): void {
    const state = this.treeState(sessionId);
    state.reload = true;
    state.error = undefined;
    const previous = state.load;
    state.load = undefined;
    previous?.controller.abort();
    if (state.published) {
      void this.startTreeLoad(sessionId, state).promise.catch(() => undefined);
    }
  }

  private startTreeLoad(sessionId: string, state: TreeState): TreeLoad {
    const force = state.reload;
    state.reload = false;
    state.error = undefined;
    const load: TreeLoad = {
      controller: new AbortController(),
      promise: Promise.resolve(),
      members: new Set()
    };
    state.load = load;
    load.promise = this.runTreeLoad(sessionId, state, load, force).finally(() => {
      if (state.load === load) state.load = undefined;
    });
    return load;
  }

  private async runTreeLoad(
    sessionId: string,
    state: TreeState,
    load: TreeLoad,
    force: boolean
  ): Promise<void> {
    try {
      await this.loadMembers(sessionId, load, force);
    } catch (error) {
      if (load.controller.signal.aborted) {
        this.logAbortedLoad(sessionId, "failed");
        return;
      }
      state.error = error;
      if (state.published) {
        await this.reportTreeRefresh(sessionId, {
          status: "failed",
          message: error instanceof Error ? error.message : String(error)
        });
        this.changed(sessionId);
      }
      return;
    }
    if (load.controller.signal.aborted) {
      this.logAbortedLoad(sessionId, "loaded");
      return;
    }
    const hadPublished = Boolean(state.published);
    state.members = load.members;
    state.published = this.buildProjection(sessionId, state.members);
    if (hadPublished) {
      await this.reportTreeRefresh(sessionId, { status: "ready" });
      this.changed(sessionId);
    }
  }

  private logAbortedLoad(sessionId: string, stage: "loaded" | "failed"): void {
    this.options.logDiagnostic?.({
      message: "Chat tree load aborted",
      sessionId,
      context: { stage, memberCount: this.options.sessionIndexStore.getTreeMembers(sessionId).length }
    });
  }

  private async loadMembers(
    sessionId: string,
    load: TreeLoad,
    force: boolean
  ): Promise<void> {
    const index = this.options.sessionIndexStore;
    const members = index.getTreeMembers(sessionId);
    await Promise.all(members.map((memberId) =>
      this.loadMember(load.members, memberId, load.controller.signal, force)
    ));
  }

  private async loadMember(
    members: Set<string>,
    sessionId: string,
    signal: AbortSignal | undefined,
    force: boolean
  ): Promise<void> {
    if (members.has(sessionId)) return;
    const index = this.options.sessionIndexStore;
    const isProviderSession = Boolean(index.getEntry(sessionId)?.providerSessionId);
    const loaded = await this.options.reconciliation.ensureSessionLoaded(sessionId, {
      force: force && isProviderSession,
      requireFull: isProviderSession,
      signal
    });
    if (loaded) {
      if (!signal?.aborted) members.add(sessionId);
      return;
    }
    if (index.getEntry(sessionId)?.archivedAt) return;
    throw new Error(`Unable to load tree member: ${sessionId}`);
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

  private buildProjection(
    sessionId: string,
    loaded: ReadonlySet<string>,
    withWindows = false
  ): TreeProjection {
    const { runtimeService, sessionIndexStore: index } = this.options;
    const treeId = index.getTreeId(sessionId);
    const treeMembers = index.getTreeMembers(sessionId);
    const members = treeMembers.filter((id) => loaded.has(id));
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
      const prefix = relation?.sourceTurnId
        ? parentPath.slice(0, sourceIndex + 1) : [];
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
    // 隐藏分支继续提供共享历史，但自身不再是可选中、可发送的路径。
    for (const memberId of members) {
      if (index.getEntry(memberId)?.hiddenAt) paths.delete(memberId);
    }
    const retained = new Set([...paths.values()].flat());
    const visibleNodes = nodes.filter((node) => retained.has(node.nodeId));
    const parentIds = new Set(visibleNodes.map((node) => node.parentNodeId));
    const forkIds = new Set(relations.filter((relation) => relation.relationType === "fork")
      .map((relation) => relation.childSessionId));
    const complete = treeMembers.every((id) => loaded.has(id));
    for (const node of visibleNodes) {
      const owner = turnsById.get(node.nodeId)!.sessionId;
      Object.assign(node, { sessionId: owner, canHide: complete && !parentIds.has(node.nodeId) &&
        forkIds.has(owner) && !index.getEntry(owner)?.hiddenAt });
    }
    const view = index.getTreeView(treeId);
    const stored = view && paths.has(view.sessionId) ? view : undefined;
    const currentSessionId = stored?.sessionId ?? (paths.has(sessionId) ? sessionId : paths.keys().next().value ?? treeId);
    // Legacy views did not distinguish automatic cursors from explicit jumps; resume tip following.
    const currentNodeId = stored?.followTip === false ? stored.nodeId : paths.get(currentSessionId)?.at(-1);
    const currentPath = paths.get(currentSessionId) ?? [];
    const visibleTurnIds = currentNodeId ? currentPath.slice(0, currentPath.indexOf(currentNodeId) + 1) : [];
    const windows = !withWindows ? undefined : members.flatMap((memberId) => {
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
      workspaceId: index.getEntry(treeId)?.workspaceId ?? index.getEntry(sessionId)?.workspaceId,
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

  /** 查看位置变更产生新的投影，已发布投影本身不被就地改写。 */
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
    this.treeState(sessionId).published = {
      ...projection,
      tree: {
        ...projection.tree,
        currentSessionId: view.sessionId,
        currentNodeId,
        visibleTurnIds,
        visibleNodeIds: visibleTurnIds,
        nodes: projection.tree.nodes.map((node) => ({
          ...node,
          isCurrent: node.nodeId === currentNodeId
        }))
      }
    };
  }

  /**
   * 读取会话树：没有快照时等待本代加载完成；快照稳定时从已加载成员派生新投影；
   * 刷新进行中或刷新失败时保持已发布快照，不让中间结果覆盖已显示的树。
   */
  public async get(sessionId: string, scope: ChatTreeScope = "tree"): Promise<ChatTreeSnapshot> {
    await this.options.sessionIndexStore.ready();
    if (scope === "path") return this.getViewPath(sessionId);
    const state = this.treeState(sessionId);
    if (state.published) {
      await this.rebuildIfSettled(sessionId, state);
    } else {
      await this.awaitTreeLoad(sessionId, state);
    }
    if (!state.published) {
      throw state.error ?? new Error(`Unable to load tree: ${sessionId}`);
    }
    if (!this.options.sessionIndexStore.getTreeView(sessionId)) {
      const tree = this.publishedProjection(sessionId).tree;
      const view = { sessionId: tree.currentSessionId!, nodeId: tree.currentNodeId, followTip: true };
      await this.options.sessionIndexStore.setTreeView(sessionId, view);
      this.applyPublishedView(sessionId, view);
    }
    return this.publishedProjection(sessionId).tree;
  }

  /**
   * 读取当前查看路径：只加载被查看分支及其 fork 祖先，并附带这些成员的正文窗口，
   * 使消息区不必等待整棵树的其余分支。
   */
  private async getViewPath(sessionId: string): Promise<ChatTreeSnapshot> {
    const chain = this.viewPathMembers(sessionId);
    const members = new Set<string>();
    await Promise.all(chain.map((memberId) => this.loadMember(members, memberId, undefined, false)));
    return this.buildProjection(sessionId, members, true).tree;
  }

  /** 查看路径的成员：被查看分支及其 fork 祖先，按祖先在前排列。 */
  private viewPathMembers(sessionId: string): string[] {
    const index = this.options.sessionIndexStore;
    const members = new Set(index.getTreeMembers(sessionId));
    const view = index.getTreeView(index.getTreeId(sessionId));
    const viewed = view && members.has(view.sessionId) ? view.sessionId
      : members.has(sessionId) ? sessionId
        : [...members][0];
    const parentByChild = new Map(index.listRelations()
      .filter((relation) => relation.relationType === "fork")
      .map((relation) => [relation.childSessionId, relation.parentSessionId] as const));
    const chain: string[] = [];
    for (let current = viewed; current && members.has(current) && !chain.includes(current);) {
      chain.unshift(current);
      current = parentByChild.get(current)!;
    }
    return chain;
  }

  /**
   * 稳定状态下补齐索引新成员并重建投影。等待期间开始的刷新由新代接管发布，
   * 这里不再用中间结果覆盖已发布快照。
   */
  private async rebuildIfSettled(sessionId: string, state: TreeState): Promise<void> {
    if (state.load || state.error || state.reload) return;
    const index = this.options.sessionIndexStore;
    const pendingTargets = new Set([...this.operations.values()]
      .map((entry) => entry.operation)
      .filter((operation) => operation.status !== "sent" && operation.targetSessionId)
      .map((operation) => operation.targetSessionId!));
    const missing = index.getTreeMembers(sessionId).filter((memberId) =>
      !state.members.has(memberId) &&
      !pendingTargets.has(memberId));
    await Promise.all(missing.map((memberId) =>
      this.loadMember(state.members, memberId, undefined, false)
    ));
    if (state.load || state.error || state.reload) return;
    state.published = this.buildProjection(sessionId, state.members);
  }

  /** 失效会打断本代加载，本次读取接续新一代，直到有发布结果或确定失败。 */
  private async awaitTreeLoad(
    sessionId: string,
    state: TreeState
  ): Promise<TreeProjection | undefined> {
    const load = state.load ?? this.startTreeLoad(sessionId, state);
    await load.promise;
    if (state.load || state.reload) {
      return this.awaitTreeLoad(sessionId, state);
    }
    return state.published;
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

  public async getNodeTarget(sessionId: string, nodeId: string): Promise<{ sessionId: string; canHide: boolean }> {
    await this.options.sessionIndexStore.ready();
    await this.get(sessionId);
    const { tree, turnsById } = this.publishedProjection(sessionId);
    if (!tree.nodes.some((node) => node.nodeId === nodeId)) throw new Error(`Unknown tree node: ${nodeId}`);
    const owner = turnsById.get(nodeId)!.sessionId;
    const index = this.options.sessionIndexStore;
    return { sessionId: owner, canHide: !index.getEntry(owner)?.hiddenAt &&
      index.listRelations().some((relation) => relation.relationType === "fork" && relation.childSessionId === owner) &&
      !tree.nodes.some((node) => node.parentNodeId === nodeId) };
  }

  public async hideBranch(sessionId: string, nodeId: string, hide: (memberId: string) => Promise<unknown>): Promise<{ hidden: true }> {
    const target = await this.getNodeTarget(sessionId, nodeId);
    if (!target.canHide) throw new Error("Only a terminal fork node can be hidden.");
    await hide(target.sessionId);
    for (const [operationId, state] of this.operations) {
      if (state.operation.targetSessionId === target.sessionId) this.operations.delete(operationId);
    }
    const index = this.options.sessionIndexStore;
    if (index.getTreeView(sessionId)?.sessionId === target.sessionId) {
      // 隐藏当前查看的分支后回到它分出来的共享祖先。
      const fork = index.listRelations().find((relation) =>
        relation.relationType === "fork" && relation.childSessionId === target.sessionId);
      if (fork) {
        const view = { sessionId: fork.parentSessionId, nodeId: fork.sourceTurnId, followTip: false };
        await index.setTreeView(sessionId, view);
        this.applyPublishedView(sessionId, view);
      }
    }
    this.changed(sessionId);
    return { hidden: true };
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
      member = await this.options.capabilities.forkSessionFromTurn(member, target);
      const state = this.treeState(sessionId);
      await this.loadMember(state.members, member, undefined, false);
      state.published = this.buildProjection(sessionId, state.members);
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
        operation.targetSessionId = await this.options.capabilities.forkSessionFromTurn(
          source,
          operation.nodeId
        );
        this.changed(operation.sessionId);
      }
      if (state.cancelRequested) return;
      await this.loadMember(
        this.treeState(operation.sessionId).members,
        operation.targetSessionId,
        undefined,
        false
      );
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
