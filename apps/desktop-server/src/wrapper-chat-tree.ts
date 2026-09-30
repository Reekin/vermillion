import { randomUUID } from "node:crypto";
import { beginSessionStage, reportSessionReadCounts } from "./session-load-trace.js";
import type { Turn, ChatTreeSendInput, ChatTreeSendOperation, CommandEnvelope } from "@vermillion/shared";
import type { SessionIndexStore } from "./session-index.js";
import type { SessionRuntimeService } from "./runtime-service.js";
import type { SessionReconciliationService } from "./session-discovery.js";
import type { CapabilityRegistry } from "./capability-registry.js";
import { buildSessionWindowSnapshotFromPage, type SessionWindowSnapshot } from "./session-window.js";

export type ChatTreeNodeSnapshot = {
  nodeId: string;
  sessionId?: string;
  parentNodeId?: string;
  label: string;
  summary?: string;
  turnId?: string;
  order: number;
  isCurrent: boolean;
  unread?: boolean;
  status?: "pending" | "completed" | "interrupted" | "replaced" | "reviewEnded";
};

export type ChatTreeSnapshot = {
  sessionId: string;
  treeId?: string;
  workspaceId?: string;
  currentSessionId?: string;
  memberSessionIds?: string[];
  windows?: SessionWindowSnapshot[];
  engineId: string;
  currentNodeId?: string;
  visibleNodeIds?: string[];
  visibleTurnIds?: string[];
  nodes: ChatTreeNodeSnapshot[];
  members?: Array<{ sessionId: string; status: "idle" | "running" | "awaiting_approval" | "error" | "completed"; updatedAt: string }>;
  fetchedAt: string;
};

type SendOperationState = {
  operation: ChatTreeSendOperation;
  cancelRequested: boolean;
  completion?: Promise<void>;
  cleanup?: Promise<ChatTreeSendOperation>;
};

type TreeProjection = {
  tree: ChatTreeSnapshot;
  /** 每个成员的完整引擎路径，包括被隐藏的轮次；发送时据此判断是否需要 fork。 */
  paths: Map<string, string[]>;
  turnsById: Map<string, Turn>;
  /** 被隐藏的节点及其全部后继。 */
  hidden: Set<string>;
};

type TreeView = { sessionId: string; nodeId?: string; followTip?: boolean };

/** 解析查看位置；落在隐藏范围内时回到该路径上最后一个可见节点。 */
const resolveView = ({ paths, hidden, turnsById }: Omit<TreeProjection, "tree">, view: TreeView): TreeView => {
  const path = paths.get(view.sessionId) ?? [];
  const nodeId = view.followTip === false ? view.nodeId : path.at(-1);
  if (!nodeId || !hidden.has(nodeId)) return { sessionId: view.sessionId, nodeId, followTip: view.followTip !== false };
  const fallback = path[path.findIndex((id) => hidden.has(id)) - 1];
  return { sessionId: fallback ? turnsById.get(fallback)!.sessionId : view.sessionId, nodeId: fallback, followTip: false };
};

const viewPosition = (projection: Omit<TreeProjection, "tree">, view: TreeView) => {
  const { sessionId, nodeId } = resolveView(projection, view);
  const path = projection.paths.get(sessionId) ?? [];
  const visibleTurnIds = nodeId ? path.slice(0, path.indexOf(nodeId) + 1) : [];
  return { currentSessionId: sessionId, currentNodeId: nodeId, visibleTurnIds, visibleNodeIds: visibleTurnIds };
};

/** `tree` 只给树结构，`path` 给当前查看路径的位置与正文窗口。 */
export type ChatTreeScope = "tree" | "path";
export type KnownSessionWindows = Record<string, { revision: string; cursor?: string }>;

type TreeLoad = {
  controller: AbortController;
  promise: Promise<void>;
  consumers: Set<symbol>;
  background: boolean;
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
    /** Source validation belongs to the engine/shell, not the tree projection. */
    ensureHistoryCurrent?: (sessionId: string, signal?: AbortSignal) => Promise<boolean>;
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
      void this.startTreeLoad(sessionId, state, true).promise.catch(() => undefined);
    }
  }

  private startTreeLoad(sessionId: string, state: TreeState, background = false): TreeLoad {
    const force = state.reload;
    state.reload = false;
    state.error = undefined;
    const load: TreeLoad = {
      controller: new AbortController(),
      promise: Promise.resolve(),
      consumers: new Set(),
      background,
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
    signal?.throwIfAborted();
    if (members.has(sessionId)) return;
    const index = this.options.sessionIndexStore;
    const isProviderSession = Boolean(index.getEntry(sessionId)?.providerSessionId);
    const loaded = await this.options.reconciliation.ensureSessionLoaded(sessionId, {
      force: force && isProviderSession,
      requireFull: isProviderSession,
      signal
    });
    signal?.throwIfAborted();
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
    sessionId: string, loaded: ReadonlySet<string>, withWindows = false, knownWindows?: KnownSessionWindows, viewSessionId?: string
  ): TreeProjection {
    const span = beginSessionStage("tree.project", { memberSessionId: sessionId, members: loaded.size, withWindows });
    try {
      const result = this.buildProjectionValue(sessionId, loaded, withWindows, knownWindows, viewSessionId);
      span.emit("end", { outcome: "ok", nodes: result.tree.nodes.length, windows: result.tree.windows?.length ?? 0 });
      return result;
    } catch (error) {
      span.emit("end", { outcome: "error" });
      throw error;
    }
  }

  private buildProjectionValue(
    sessionId: string,
    loaded: ReadonlySet<string>,
    withWindows = false,
    knownWindows?: KnownSessionWindows,
    viewSessionId?: string
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
    // 成员按祖先在前排列，节点顺序保证父节点先于子节点判定。
    const hiddenTurnIds = new Set(members.flatMap((memberId) => index.getEntry(memberId)?.hiddenTurnIds ?? []));
    const hidden = new Set<string>();
    for (const node of nodes) {
      if (hiddenTurnIds.has(node.nodeId) || (node.parentNodeId && hidden.has(node.parentNodeId))) hidden.add(node.nodeId);
    }
    const visibleNodes = nodes.filter((node) => !hidden.has(node.nodeId));
    for (const node of visibleNodes) node.sessionId = turnsById.get(node.nodeId)!.sessionId;
    const view = viewSessionId ? { sessionId: viewSessionId } : index.getTreeView(treeId);
    const position = viewPosition({ paths, turnsById, hidden }, view && paths.has(view.sessionId) ? view
      : { sessionId: paths.has(sessionId) ? sessionId : paths.keys().next().value ?? treeId });
    const windows = !withWindows ? undefined : members.flatMap((memberId) => {
      const memberSession = sessionsById.get(memberId);
      if (!memberSession) return [];
      if (runtimeService.hasSessionWindow(memberId, knownWindows?.[memberId])) return [];
      const window = buildSessionWindowSnapshotFromPage({
        ...snapshot,
        sessionId: memberId,
        session: memberSession,
        conversation: snapshot.conversations.find((item) =>
          item.conversationId === memberSession.conversationId)!,
        turns: (turnsBySessionId.get(memberId) ?? []).filter((turn) => !hidden.has(turn.turnId)),
        sessionRelations: snapshot.sessionRelations.filter((item) =>
          item.parentSessionId === memberId || item.childSessionId === memberId),
        participants: snapshot.participants.filter((item) =>
          item.conversationId === memberSession.conversationId),
        cursor: runtimeService.getRevision() === "initial" ? undefined : runtimeService.getRevision(),
        hasOlder: false,
        hasNewer: false,
        replaceSessionHistory: true
      });
      window.revision = runtimeService.getSessionHistoryRevision(memberId);
      return [window];
    });
    const tree: ChatTreeSnapshot = {
      sessionId, treeId, memberSessionIds: treeMembers, ...position,
      workspaceId: index.getEntry(treeId)?.workspaceId ?? index.getEntry(sessionId)?.workspaceId,
      engineId: snapshot.sessions.find((item) => item.sessionId === treeId)!.engineId,
      nodes: visibleNodes.map((node) => ({ ...node, isCurrent: node.nodeId === position.currentNodeId })),
      windows, fetchedAt: new Date().toISOString()
    };
    return { tree, paths, turnsById, hidden };
  }

  private publishedProjection(sessionId: string): TreeProjection {
    const published = this.treeState(sessionId).published;
    if (!published) throw new Error(`Chat tree is not loaded: ${sessionId}`);
    return published;
  }

  /** 查看位置变更产生新的投影，已发布投影本身不被就地改写。 */
  private applyPublishedView(sessionId: string, view: TreeView): void {
    const projection = this.publishedProjection(sessionId);
    const position = viewPosition(projection, view);
    this.treeState(sessionId).published = {
      ...projection,
      tree: {
        ...projection.tree,
        ...position,
        nodes: projection.tree.nodes.map((node) => ({
          ...node,
          isCurrent: node.nodeId === position.currentNodeId
        }))
      }
    };
  }

  /**
   * 读取会话树：没有快照时等待本代加载完成；快照稳定时从已加载成员派生新投影；
   * 刷新进行中或刷新失败时保持已发布快照，不让中间结果覆盖已显示的树。
   */
  public async get(sessionId: string, scope: ChatTreeScope = "tree", knownWindows?: KnownSessionWindows, signal?: AbortSignal, viewSessionId?: string): Promise<ChatTreeSnapshot> {
    signal?.throwIfAborted();
    await this.options.sessionIndexStore.ready();
    signal?.throwIfAborted();
    if (scope === "path") return this.getViewPath(sessionId, knownWindows, signal, viewSessionId);
    const state = this.treeState(sessionId);
    if (state.published) {
      await this.rebuildIfSettled(sessionId, state, signal);
    } else {
      await this.awaitTreeLoad(sessionId, state, signal);
    }
    signal?.throwIfAborted();
    if (!state.published) {
      throw state.error ?? new Error(`Unable to load tree: ${sessionId}`);
    }
    if (!this.options.sessionIndexStore.getTreeView(sessionId)) {
      const projection = this.publishedProjection(sessionId);
      const view = resolveView(projection, { sessionId: projection.tree.currentSessionId! });
      await this.options.sessionIndexStore.setTreeView(sessionId, view);
      signal?.throwIfAborted();
      this.applyPublishedView(sessionId, view);
    }
    return this.publishedProjection(sessionId).tree;
  }

  /**
   * 读取当前查看路径：只加载被查看分支及其 fork 祖先，并附带这些成员的正文窗口，
   * 使消息区不必等待整棵树的其余分支。指定 viewSessionId 时读取该成员分支末端，不改变保存的查看位置。
   */
  private async getViewPath(sessionId: string, knownWindows?: KnownSessionWindows, signal?: AbortSignal, viewSessionId?: string): Promise<ChatTreeSnapshot> {
    const index = this.options.sessionIndexStore;
    const view = viewSessionId && index.getTreeMembers(sessionId).includes(viewSessionId) ? viewSessionId : undefined;
    const chain = this.viewPathMembers(sessionId, view);
    const members = new Set<string>();
    let completed = 0;
    reportSessionReadCounts(completed, chain.length);
    await Promise.all(chain.map(async (memberId) => {
      signal?.throwIfAborted();
      await this.options.ensureHistoryCurrent?.(memberId, signal);
      await this.loadMember(members, memberId, signal, false);
      reportSessionReadCounts(++completed, chain.length);
    }));
    signal?.throwIfAborted();
    return this.buildProjection(sessionId, members, true, knownWindows, view).tree;
  }

  /** 查看路径的成员：被查看分支及其 fork 祖先，按祖先在前排列。 */
  private viewPathMembers(sessionId: string, viewSessionId?: string): string[] {
    const index = this.options.sessionIndexStore;
    const members = new Set(index.getTreeMembers(sessionId));
    const view = viewSessionId ? { sessionId: viewSessionId } : index.getTreeView(index.getTreeId(sessionId));
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
  private async rebuildIfSettled(sessionId: string, state: TreeState, signal?: AbortSignal): Promise<void> {
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
      this.loadMember(state.members, memberId, signal, false)
    ));
    signal?.throwIfAborted();
    if (state.load || state.error || state.reload) return;
    state.published = this.buildProjection(sessionId, state.members);
  }

  /** 失效会打断本代加载，本次读取接续新一代，直到有发布结果或确定失败。 */
  private async awaitTreeLoad(
    sessionId: string,
    state: TreeState,
    signal?: AbortSignal
  ): Promise<TreeProjection | undefined> {
    signal?.throwIfAborted();
    const load = state.load ?? this.startTreeLoad(sessionId, state);
    const consumer = Symbol();
    load.consumers.add(consumer);
    let onAbort: (() => void) | undefined;
    try {
      await (signal ? Promise.race([
        load.promise,
        new Promise<never>((_, reject) => {
          onAbort = () => reject(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        })
      ]) : load.promise);
    } finally {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      load.consumers.delete(consumer);
      if (!load.background && load.consumers.size === 0 && state.load === load) {
        state.load = undefined;
        load.controller.abort();
      }
    }
    signal?.throwIfAborted();
    if (state.load || state.reload) {
      return this.awaitTreeLoad(sessionId, state, signal);
    }
    return state.published;
  }

  public async selectSession(sessionId: string): Promise<void> {
    await this.get(sessionId);
    const view = resolveView(this.publishedProjection(sessionId), { sessionId });
    await this.options.sessionIndexStore.setTreeView(sessionId, view);
    this.applyPublishedView(sessionId, view);
    this.options.runtimeService.notifyChatTreeChanged(sessionId, this.publishedProjection(sessionId).tree.visibleTurnIds ?? []);
  }

  /** 节点所在的会话；只接受当前可见的节点。 */
  public async getNodeSession(sessionId: string, nodeId: string): Promise<string> {
    await this.options.sessionIndexStore.ready();
    await this.get(sessionId);
    const node = this.publishedProjection(sessionId).tree.nodes.find((item) => item.nodeId === nodeId);
    if (!node) throw new Error(`Unknown tree node: ${nodeId}`);
    return node.sessionId!;
  }

  /** 只记录这一个节点；它的后继在投影时一并隐藏。 */
  public async hideNode(sessionId: string, nodeId: string): Promise<{ hidden: true }> {
    const owner = await this.getNodeSession(sessionId, nodeId);
    if (!this.publishedProjection(sessionId).tree.nodes.find((node) => node.nodeId === nodeId)?.parentNodeId) {
      throw new Error("The root node cannot be hidden.");
    }
    const index = this.options.sessionIndexStore;
    await index.hideTurn(owner, nodeId);
    const state = this.treeState(sessionId);
    const projection = this.buildProjection(sessionId, state.members);
    state.published = projection;
    for (const [operationId, entry] of this.operations) {
      if (projection.hidden.has(entry.operation.nodeId) || projection.hidden.has(entry.operation.turnId ?? "")) {
        this.operations.delete(operationId);
      }
    }
    // 查看位置落在隐藏范围内时，持久化回退后的位置。
    const view = index.getTreeView(sessionId);
    if (view) await index.setTreeView(sessionId, resolveView(projection, view));
    this.changed(sessionId);
    return { hidden: true };
  }

  public async jump(sessionId: string, nodeId: string): Promise<{ jumped: boolean }> {
    // The graph is already loaded when a user picks a node; no engine operation belongs here.
    const projection = this.publishedProjection(sessionId);
    const member = this.resolveSendSource(projection, projection.tree.currentSessionId!, nodeId);
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
    let member = nodeId ? this.resolveSendSource(projection, sessionId, nodeId) : tree.currentSessionId!;
    if (target && !paths.get(member)?.includes(target)) {
      member = this.resolveSendSource(projection, sessionId, target);
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

  private resolveSendSource({ paths, turnsById, hidden }: TreeProjection, sessionId: string, nodeId: string): string {
    const owner = turnsById.get(nodeId)?.sessionId;
    if (!owner || hidden.has(nodeId)) throw new Error(`Unknown tree node: ${nodeId}`);
    return paths.get(sessionId)?.includes(nodeId) ? sessionId : owner;
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
        const projection = this.publishedProjection(operation.sessionId);
        if (projection.turnsById.get(operation.nodeId)?.status !== "completed") {
          throw new Error("Wait for this turn to finish before branching.");
        }
        const source = this.resolveSendSource(projection, operation.sessionId, operation.nodeId);
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
