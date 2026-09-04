import { basename, resolve } from "node:path";
import type {
  DecisionCard,
  DocChange,
  DocFile,
  InboxItem,
  Mission,
  WorkItem,
  Workspace
} from "./contracts.js";
import { DocsService } from "./docs.js";
import { WorkspaceStore } from "./workspace-store.js";

const createId = (prefix: string): string =>
  prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);

/** Source of truth for workspace identity; the session engine's registry in production. */
export type WorkspaceSource = {
  list: () => Promise<Array<{ workspaceId: string; rootPath: string; label: string; createdAt: string; updatedAt: string }>>;
  register: (input: { rootPath: string; label?: string }) => Promise<{ workspaceId: string; rootPath: string; label: string; createdAt: string; updatedAt: string }>;
  remove: (workspaceId: string) => Promise<void>;
};

export type WorkbenchServiceOptions = {
  workspaces: WorkspaceSource;
  now?: () => string;
};

export class WorkbenchService {
  private readonly workspaces: WorkspaceSource;
  private readonly now: () => string;

  constructor(options: WorkbenchServiceOptions) {
    this.workspaces = options.workspaces;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async listWorkspaces(): Promise<Workspace[]> {
    const list = await this.workspaces.list();
    return list
      .map((w) => ({ workspaceId: w.workspaceId, rootPath: w.rootPath, label: w.label, createdAt: w.createdAt, lastActiveAt: w.updatedAt }))
      .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  }

  async addWorkspace(input: { rootPath: string; label?: string }): Promise<Workspace> {
    const rootPath = resolve(input.rootPath);
    if (!(await new WorkspaceStore(rootPath).exists())) {
      throw new Error("Workspace directory does not exist: " + rootPath);
    }
    await new DocsService(rootPath).ensureRepo();
    const record = await this.workspaces.register({ rootPath, label: input.label?.trim() || basename(rootPath) });
    return { workspaceId: record.workspaceId, rootPath: record.rootPath, label: record.label, createdAt: record.createdAt, lastActiveAt: record.updatedAt };
  }

  async removeWorkspace(workspaceId: string): Promise<void> {
    await this.workspaces.remove(workspaceId);
  }

  private async requireWorkspace(workspaceId: string): Promise<Workspace> {
    const workspace = (await this.listWorkspaces()).find((w) => w.workspaceId === workspaceId);
    if (!workspace) throw new Error("Unknown workspace: " + workspaceId);
    return workspace;
  }

  private async store(workspaceId: string): Promise<WorkspaceStore> {
    return new WorkspaceStore((await this.requireWorkspace(workspaceId)).rootPath);
  }

  private async docs(workspaceId: string): Promise<DocsService> {
    return new DocsService((await this.requireWorkspace(workspaceId)).rootPath);
  }

  async listDocs(workspaceId: string): Promise<DocFile[]> {
    return (await this.docs(workspaceId)).list();
  }

  async readDoc(workspaceId: string, path: string): Promise<string> {
    return (await this.docs(workspaceId)).read(path);
  }

  async writeDoc(workspaceId: string, path: string, content: string): Promise<void> {
    await (await this.docs(workspaceId)).write(path, content);
  }

  async pendingDocChanges(workspaceId: string): Promise<DocChange[]> {
    return (await this.docs(workspaceId)).pendingChanges();
  }

  async commitDocs(workspaceId: string, message: string): Promise<string> {
    return (await this.docs(workspaceId)).commit(message);
  }

  async listMissions(workspaceId: string): Promise<Mission[]> {
    const list = await (await this.store(workspaceId)).missions.list();
    return list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async createMission(
    workspaceId: string,
    input: { title: string; summary: string; sessionId?: string; commitMessage?: string }
  ): Promise<Mission> {
    const docs = await this.docs(workspaceId);
    const pending = await docs.pendingChanges();
    const docCommit = pending.length > 0
      ? await docs.commit(input.commitMessage ?? "Mission: " + input.title)
      : (await docs.head()) ?? "";
    const now = this.now();
    const mission: Mission = {
      missionId: createId("m"),
      title: input.title.trim(),
      status: "active",
      summary: input.summary,
      docCommit,
      sessionId: input.sessionId,
      createdAt: now,
      updatedAt: now
    };
    await (await this.store(workspaceId)).missions.put(mission);
    return mission;
  }

  async updateMissionStatus(workspaceId: string, missionId: string, status: Mission["status"]): Promise<Mission> {
    const store = await this.store(workspaceId);
    const mission = await store.missions.get(missionId);
    if (!mission) throw new Error("Unknown mission: " + missionId);
    return store.missions.put({ ...mission, status, updatedAt: this.now() });
  }

  async listWorkItems(workspaceId: string, missionId?: string): Promise<WorkItem[]> {
    const list = await (await this.store(workspaceId)).workItems.list();
    return list.filter((w) => !missionId || w.missionId === missionId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async createWorkItem(
    workspaceId: string,
    input: { missionId: string; title: string; risk: WorkItem["risk"]; autoClose?: boolean }
  ): Promise<WorkItem> {
    const now = this.now();
    const item: WorkItem = {
      workItemId: createId("wi"),
      missionId: input.missionId,
      title: input.title.trim(),
      status: "queued",
      risk: input.risk,
      autoClose: input.autoClose ?? (input.risk === "R0" || input.risk === "R1"),
      createdAt: now,
      updatedAt: now
    };
    return (await this.store(workspaceId)).workItems.put(item);
  }

  async updateWorkItem(
    workspaceId: string,
    workItemId: string,
    patch: Partial<Pick<WorkItem, "status" | "sessionId" | "risk" | "autoClose">>
  ): Promise<WorkItem> {
    const store = await this.store(workspaceId);
    const item = await store.workItems.get(workItemId);
    if (!item) throw new Error("Unknown work item: " + workItemId);
    return store.workItems.put({ ...item, ...patch, updatedAt: this.now() });
  }

  async listDecisions(workspaceId: string): Promise<DecisionCard[]> {
    return (await this.store(workspaceId)).decisions.list();
  }

  async createDecision(
    workspaceId: string,
    input: Omit<DecisionCard, "decisionId" | "createdAt" | "answer">
  ): Promise<DecisionCard> {
    return (await this.store(workspaceId)).decisions.put({
      ...input,
      decisionId: createId("d"),
      createdAt: this.now()
    });
  }

  async answerDecision(
    workspaceId: string,
    decisionId: string,
    answer: { key: string; note?: string }
  ): Promise<DecisionCard> {
    const store = await this.store(workspaceId);
    const card = await store.decisions.get(decisionId);
    if (!card) throw new Error("Unknown decision: " + decisionId);
    return store.decisions.put({ ...card, answer: { ...answer, at: this.now() } });
  }

  async listInbox(): Promise<InboxItem[]> {
    const items: InboxItem[] = [];
    for (const workspace of await this.listWorkspaces()) {
      const store = new WorkspaceStore(workspace.rootPath);
      for (const card of await store.decisions.list()) {
        if (!card.answer) items.push({ kind: "decision", workspaceId: workspace.workspaceId, card });
      }
      const missions = await store.missions.list();
      for (const workItem of await store.workItems.list()) {
        if (workItem.status !== "review") continue;
        const mission = missions.find((m) => m.missionId === workItem.missionId);
        if (mission) items.push({ kind: "review", workspaceId: workspace.workspaceId, workItem, mission });
      }
    }
    return items;
  }
}
