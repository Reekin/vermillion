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

  public invalidate(sessionId: string): void {
    for (const memberId of this.options.sessionIndexStore.getTreeMembers(sessionId)) {
      this.loaded.delete(memberId);
    }
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
      if (!loaded) {
        if (this.options.sessionIndexStore.getEntry(sessionId)?.archivedAt) return;
        throw new Error(`Unable to load tree member: ${sessionId}`);
      }
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
    let windows = members.map((memberId) => {
      const session = snapshot.sessions.find((item) => item.sessionId === memberId)!;
      const relation = relations.find((item) => item.relationType === "fork" && item.childSessionId === memberId);
      const parentPath = relation ? paths.get(relation.parentSessionId) ?? [] : [];
      const sourceIndex = relation?.sourceTurnId ? parentPath.indexOf(relation.sourceTurnId) : -1;
      // Archived history can end before its original fork point after a descendant reforks earlier.
      const prefixEnd = sourceIndex < 0 && index.getEntry(memberId)?.archivedAt
        ? parentPath.length : sourceIndex + 1;
      const prefix = relation?.sourceTurnId
        ? parentPath.slice(0, prefixEnd) : [];
      const turns = snapshot.turns.filter((turn) => turn.sessionId === memberId)
        .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
      let parentNodeId = prefix.at(-1);
      const readTurnIds = new Set(index.getEntry(memberId)?.readTurnIds);
      for (const turn of turns) {
        const question = snapshot.messageBlocks.find((block) =>
          block.turnId === turn.turnId && block.role === "user" && block.text)?.text;
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
        hasOlder: false, hasNewer: false,
        replaceSessionHistory: true
      });
    });
    // Archived sessions supply shared history, but never a selectable/sendable path.
    for (const memberId of members) {
      if (index.getEntry(memberId)?.archivedAt) paths.delete(memberId);
    }
    const retained = new Set([...paths.values()].flat());
    const visibleNodes = nodes.filter((node) => retained.has(node.nodeId));
    const parentIds = new Set(visibleNodes.map((node) => node.parentNodeId));
    const forkIds = new Set(relations.filter((relation) => relation.relationType === "fork")
      .map((relation) => relation.childSessionId));
    const complete = index.getTreeMembers(sessionId).every((id) => this.loaded.has(id));
    for (const node of visibleNodes) {
      const owner = turnsById.get(node.nodeId)!.sessionId;
      Object.assign(node, { sessionId: owner, canArchive: complete && !parentIds.has(node.nodeId) &&
        forkIds.has(owner) && !index.getEntry(owner)?.archivedAt });
    }
    windows = windows.map((window) => buildSessionWindowSnapshotFromPage({
      ...window.snapshot, ...window,
      session: window.snapshot.sessions.find((session) => session.sessionId === window.sessionId)!,
      conversation: window.snapshot.conversations[0]!,
      turns: window.snapshot.turns.filter((turn) => retained.has(turn.turnId))
    }));
    const view = index.getTreeView(treeId);
    const stored = view && paths.has(view.sessionId) ? view : undefined;
    const currentSessionId = stored?.sessionId ?? (paths.has(sessionId) ? sessionId : paths.keys().next().value ?? treeId);
    // Legacy views did not distinguish automatic cursors from explicit jumps; resume tip following.
    const currentNodeId = stored?.followTip === false ? stored.nodeId : paths.get(currentSessionId)?.at(-1);
    const currentPath = paths.get(currentSessionId) ?? [];
    const visibleTurnIds = currentNodeId ? currentPath.slice(0, currentPath.indexOf(currentNodeId) + 1) : [];
    const tree: ChatTreeSnapshot = {
      sessionId, treeId, currentSessionId, memberSessionIds: members,
      engineId: snapshot.sessions.find((item) => item.sessionId === treeId)!.engineId,
      supportsJump: true, currentNodeId, visibleTurnIds, visibleNodeIds: visibleTurnIds,
      nodes: visibleNodes.map((node) => ({ ...node, isCurrent: node.nodeId === currentNodeId })),
      windows, fetchedAt: new Date().toISOString()
    };
    return { tree, paths, turnsById };
  }

  public async get(sessionId: string): Promise<ChatTreeSnapshot> {
    await this.options.sessionIndexStore.ready();
    const members = this.options.sessionIndexStore.getTreeMembers(sessionId);
    if (!members.some((id) => this.loaded.has(id))) {
      if (members.some((id) => this.options.sessionIndexStore.getEntry(id)?.archivedAt)) {
        // Ancestors borrow surviving histories before those members load themselves.
        for (const id of members) await this.loadMember(id);
      } else {
        await Promise.all(members.map((id) => this.loadMember(id)));
      }
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

  public async getNodeTarget(sessionId: string, nodeId: string): Promise<{ sessionId: string; canArchive: boolean }> {
    await this.options.sessionIndexStore.ready();
    await Promise.all(this.options.sessionIndexStore.getTreeMembers(sessionId).map((id) => this.loadMember(id)));
    const { tree, turnsById } = this.project(sessionId);
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
    const index = this.options.sessionIndexStore;
    if (index.getTreeView(sessionId)?.sessionId === target.sessionId) {
      const { tree } = this.project(sessionId);
      await index.setTreeView(sessionId, {
        sessionId: tree.currentSessionId!, nodeId: tree.currentNodeId, followTip: true
      });
    }
    this.changed(sessionId);
    return { archived: true };
  }

  public async jump(sessionId: string, nodeId: string): Promise<{ jumped: boolean }> {
    // The graph is already loaded when a user picks a node; no engine operation belongs here.
    const { tree, paths, turnsById } = this.project(sessionId);
    const member = this.resolveSendSource(tree.currentSessionId!, nodeId, paths, turnsById);
    await this.options.sessionIndexStore.setTreeView(sessionId, { sessionId: member, nodeId, followTip: false });
    return { jumped: true };
  }

  public async prepareSend(sessionId: string, nodeId?: string): Promise<{ sessionId: string }> {
    await this.get(sessionId);
    const { tree, paths, turnsById } = this.project(sessionId);
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
    }
    const view = { sessionId: member, nodeId: target, followTip: true };
    await this.options.sessionIndexStore.setTreeView(sessionId, view);
    return { sessionId: member };
  }

  public async markRead(sessionId: string, nodeId: string): Promise<{ readNodeIds: string[] }> {
    await this.get(sessionId);
    const { paths, turnsById } = this.project(sessionId);
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
        const { paths, turnsById } = this.project(operation.sessionId);
        if (turnsById.get(operation.nodeId)?.status !== "completed") {
          throw new Error("Wait for this turn to finish before branching.");
        }
        const source = this.resolveSendSource(operation.sessionId, operation.nodeId, paths, turnsById);
        operation.targetSessionId = await this.options.fork(source, operation.nodeId);
        this.changed(operation.sessionId);
      }
      await this.loadMember(operation.targetSessionId);
      operation.status = "sending";
      this.changed(operation.sessionId);
      const receipt = await send({ commandId: randomUUID(), command: {
        type: "sendUserMessage", sessionId: operation.targetSessionId,
        messageId: randomUUID(), content: operation.content, attachments: structuredClone(operation.attachments),
        execution: structuredClone(operation.execution)
      } });
      if (!receipt.accepted || !receipt.turnId) throw new Error(receipt.error?.message || "Branch message was not accepted.");
      operation.turnId = receipt.turnId;
      operation.status = "sent";
    } catch (error) {
      operation.status = "failed";
      operation.error = error instanceof Error ? error.message : String(error);
    }
    this.changed(operation.sessionId);
  }
}

type TreeSend = (command: CommandEnvelope) => Promise<Pick<import("./runtime-types.js").CommandReceipt, "accepted" | "turnId" | "error">>;
