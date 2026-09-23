import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";
import { startLocalEndpoint } from "../src/local-endpoint.js";
import { AppLauncher } from "../src/app-launcher.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
    delete process.env.VERMILLION_PERSISTENCE_BASE_DIR;
    delete process.env.VERMILLION_ACCEPTANCE_LAUNCH_TOKEN;
  delete process.env.CODEX_HOME;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("vermillion cli", () => {
  it("distinguishes Issues from execution work items in help", async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { out.push(String(chunk)); return true; });
    expect(await runCli(["--help"])).toBe(0);
    const global = out.pop()!;
    expect(global).toMatch(/执行工单 WorkItem[^\n]*\n(?:    [^\n]*\n)*    workItem\.list/);
    expect(global).toMatch(/Issues（问题与建议的分诊记录，不是执行工单）\n(?:    [^\n]*\n)*    issue\.list/);
    expect(await runCli(["workItem.list", "--help"])).toBe(0);
    expect(out.pop()).toContain("不返回 Issues 中的问题与建议");
    expect(await runCli(["issue.list", "--help"])).toBe(0);
    expect(out.pop()).toContain("不返回执行工单（WorkItem）");
  });

  it("updates, preserves and clears resource claims through workItem.update", async () => {
    const base = await mkdtemp(join(tmpdir(), "verm-cli-needs-"));
    const root = await mkdtemp(join(tmpdir(), "verm-cli-needs-ws-"));
    dirs.push(base, root);
    process.env.VERMILLION_PERSISTENCE_BASE_DIR = base;
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { out.push(String(chunk)); return true; });
    const call = async (method: string, params: object) => {
      expect(await runCli([method, JSON.stringify(params)])).toBe(0);
      return JSON.parse(out.pop()!);
    };
    const { workspaceId } = await call("workspace.add", { rootPath: root });
    const { workItemId } = await call("workItem.create", {
      workspaceId, title: "Resources", objective: "isolated acceptance", risk: "R1", needs: ["browser:qa-profile"],
      scope: { inScope: [], outOfScope: [], allowedPaths: [] }, acceptance: [{ text: "done" }]
    });
    const id = { workspaceId, workItemId };
    await call("workItem.update", { ...id, needs: ["shared:staging-db"], note: "具体对象" });
    expect((await call("workItem.get", id)).needs).toEqual(["shared:staging-db"]);
    await call("workItem.update", { ...id, title: "Renamed", note: "标题" });
    expect((await call("workItem.get", id)).needs).toEqual(["shared:staging-db"]);
    await call("workItem.update", { ...id, needs: [], note: "独立实例" });
    expect((await call("workItem.get", id)).needs).toEqual([]);
  });

  it("starts and stops its own build without forwarding app methods to a desktop endpoint", async () => {
    const base = await mkdtemp(join(tmpdir(), "verm-cli-launch-"));
    const root = "I:/candidate";
    dirs.push(base);
    process.env.VERMILLION_PERSISTENCE_BASE_DIR = base;
    const endpointHandler = vi.fn(async () => ({ ok: false as const, error: "old desktop" }));
    const endpoint = await startLocalEndpoint(base, endpointHandler);
    const started = { pid: 123, instanceId: "instance", cdpUrl: "http://127.0.0.1:19671", desktop: "vermillion-qa", dataDir: base,
      targetPath: root, targetKind: "source" as const, targetRevision: "abc", buildId: "sha256:abc", logPath: join(base, "acceptance-launch.jsonl"),
      cli: { targetFile: join(base, "acceptance-target.json"), executable: process.execPath, args: ["vermillion.mjs", "--target", join(base, "acceptance-target.json")] } };
    const start = vi.spyOn(AppLauncher.prototype, "start").mockResolvedValue(started);
    const stop = vi.spyOn(AppLauncher.prototype, "stop").mockResolvedValue({ dataDir: base, pid: 123, stopped: true, portReleased: true });
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { out.push(String(chunk)); return true; });
    try {
      expect(await runCli(["app.start", JSON.stringify({ targetPath: root, dataDir: base, port: 19671 })])).toBe(0);
      expect(start).toHaveBeenCalledWith({ targetPath: root, dataDir: base, port: 19671 });
      expect(JSON.parse(out.pop()!).pid).toBe(123);
      expect(await runCli(["app.stop", JSON.stringify({ dataDir: base, pid: 123, instanceId: "instance" })])).toBe(0);
      expect(stop).toHaveBeenCalledWith({ dataDir: base, pid: 123, instanceId: "instance" });
      expect(endpointHandler).not.toHaveBeenCalled();
    } finally {
      await endpoint.close();
    }
  });

  it("documents the required source and release candidate identities", async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { out.push(String(chunk)); return true; });
    expect(await runCli(["app.start", "--help"])).toBe(0);
    expect(out.join("")).toContain("expectedRevision");
    expect(out.join("")).toContain("expectedBuildId");
    expect(out.join("")).toContain("源码示例");
    expect(out.join("")).toContain("发布示例");
  });

  it("runs registry methods against the persistence dir and prints JSON", async () => {
    const base = await mkdtemp(join(tmpdir(), "verm-cli-"));
    const root = await mkdtemp(join(tmpdir(), "verm-cli-ws-"));
    dirs.push(base, root);
    process.env.VERMILLION_PERSISTENCE_BASE_DIR = base;
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { out.push(String(chunk)); return true; });
    expect(await runCli(["workspace.add", JSON.stringify({ rootPath: root, label: "X" })])).toBe(0);
    const added = JSON.parse(out.pop()!);
    expect(added.label).toBe("X");
    expect(await runCli(["workspace.list"])).toBe(0);
    expect(JSON.parse(out.pop()!).map((w: { workspaceId: string }) => w.workspaceId)).toEqual([added.workspaceId]);
    expect(await runCli(["nope"])).toBe(1);
  });

  it("routes to the running desktop endpoint when one is published", async () => {
    const base = await mkdtemp(join(tmpdir(), "verm-cli-ep-"));
    dirs.push(base);
    process.env.VERMILLION_PERSISTENCE_BASE_DIR = base;
    const seen: string[] = [];
    const endpoint = await startLocalEndpoint(base, async (request) => {
      seen.push(request.method);
      return { ok: true, result: [{ workspaceId: "ws-remote", rootPath: "X:/r", label: "Remote", createdAt: "t", lastActiveAt: "t" }] };
    });
    try {
      const out: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { out.push(String(chunk)); return true; });
      expect(await runCli(["workspace.list"])).toBe(0);
      expect(JSON.parse(out.pop()!)[0].label).toBe("Remote");
      expect(seen).toContain("workspace.list");
    } finally {
      await endpoint.close();
    }
  });

  it("binds --target calls to the exact acceptance instance and never falls back", async () => {
    const base = await mkdtemp(join(tmpdir(), "verm-cli-target-"));
    dirs.push(base);
    const instanceId = "acceptance-instance";
    const endpoint = await startLocalEndpoint(base, async (request) => request.method === "runtime.info"
      ? { ok: true as const, result: { buildId: "sha256:target", pid: process.pid, startedAt: "t", schedulerOnline: true } }
      : { ok: true as const, result: [] }, { pid: process.pid, instanceId });
    const descriptor = join(base, "acceptance-target.json");
    await writeFile(descriptor, JSON.stringify({ dataDir: base, pid: process.pid, instanceId }), "utf8");
    const out: string[] = [], errors: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { out.push(String(chunk)); return true; });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { errors.push(String(chunk)); return true; });
    try {
      expect(await runCli(["--target", descriptor, "runtime.info", "{}"])).toBe(0);
      expect(JSON.parse(out.pop()!).buildId).toBe("sha256:target");
      await endpoint.close();
      expect(await runCli(["--target", descriptor, "runtime.info", "{}"])).toBe(1);
      expect(errors.join("")).toContain("Target instance is not running");
    } finally {
      await endpoint.close();
    }
  });

  it("uses the inherited acceptance identity for ordinary CLI calls inside the instance", async () => {
    const base = await mkdtemp(join(tmpdir(), "verm-cli-inherited-target-"));
    dirs.push(base);
    const instanceId = "inherited-instance";
    const endpoint = await startLocalEndpoint(base, async () => ({
      ok: true as const,
      result: { buildId: "sha256:inherited", pid: process.pid, startedAt: "t", schedulerOnline: true }
    }), { pid: process.pid, instanceId });
    process.env.VERMILLION_PERSISTENCE_BASE_DIR = base;
    process.env.VERMILLION_ACCEPTANCE_LAUNCH_TOKEN = instanceId;
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { out.push(String(chunk)); return true; });
    try {
      expect(await runCli(["runtime.info", "{}"])).toBe(0);
      expect(JSON.parse(out.pop()!).buildId).toBe("sha256:inherited");
    } finally {
      await endpoint.close();
    }
  });

  it("routes asksource and steer through the running desktop endpoint", async () => {
    const base = await mkdtemp(join(tmpdir(), "verm-cli-session-communication-"));
    dirs.push(base);
    process.env.VERMILLION_PERSISTENCE_BASE_DIR = base;
    const requests: Array<{ method: string; params: unknown }> = [];
    const endpoint = await startLocalEndpoint(base, async (request) => {
      requests.push(request);
      if (request.method === "asksource") {
        return { ok: true as const, result: { answer: "clarified", askSessionId: "ask", askTurnId: "ask-turn", archived: true } };
      }
      return { ok: true as const, result: { sessionId: "target", turnId: "turn", delivery: "started" } };
    });
    try {
      const out: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { out.push(String(chunk)); return true; });
      expect(await runCli(["asksource", JSON.stringify({ workspaceId: "ws", workItemId: "item", sessionId: "worker", question: "Clarify" })])).toBe(0);
      expect(JSON.parse(out.pop()!).answer).toBe("clarified");
      expect(await runCli(["steer", JSON.stringify({ sessionId: "target", content: "Continue" })])).toBe(0);
      expect(JSON.parse(out.pop()!)).toEqual({ sessionId: "target", turnId: "turn", delivery: "started" });
      expect(requests.filter((request) => request.method === "asksource" || request.method === "steer")).toEqual([
        { method: "asksource", params: { workspaceId: "ws", workItemId: "item", sessionId: "worker", question: "Clarify" } },
        { method: "steer", params: { sessionId: "target", content: "Continue" } }
      ]);
    } finally {
      await endpoint.close();
    }
  });

  it("routes app.window through the target desktop endpoint", async () => {
    const base = await mkdtemp(join(tmpdir(), "verm-cli-window-"));
    dirs.push(base);
    process.env.VERMILLION_PERSISTENCE_BASE_DIR = base;
    const requests: string[] = [];
    const endpoint = await startLocalEndpoint(base, async (request) => {
      requests.push(request.method);
      if (request.method === "workspace.list") return { ok: true as const, result: [] };
      return { ok: true as const, result: { dataDir: base, pid: 123, action: "status", visible: true, minimized: false } };
    });
    try {
      const out: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { out.push(String(chunk)); return true; });
      expect(await runCli(["app.window", JSON.stringify({ dataDir: base, pid: 123, action: "status" })])).toBe(0);
      expect(JSON.parse(out.pop()!)).toMatchObject({ dataDir: base, pid: 123, action: "status" });
      expect(requests).toEqual(["runtime.info", "app.window"]);
    } finally {
      await endpoint.close();
    }
  });

  it("searches registered work items and rollout files through the CLI", async () => {
    const base = await mkdtemp(join(tmpdir(), "verm-cli-search-"));
    const root = await mkdtemp(join(tmpdir(), "verm-cli-search-ws-"));
    dirs.push(base, root);
    process.env.VERMILLION_PERSISTENCE_BASE_DIR = base;
    process.env.CODEX_HOME = base;
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { out.push(String(chunk)); return true; });
    const call = async (method: string, params: object) => {
      expect(await runCli([method, JSON.stringify(params)])).toBe(0);
      return JSON.parse(out.pop()!);
    };
    const workspace = await call("workspace.add", { rootPath: root, label: "Search workspace" });
    await call("workItem.create", {
      workspaceId: workspace.workspaceId,
      title: "CLI search item",
      objective: "cli-search-needle in the objective",
      risk: "R1",
      scope: { inScope: [], outOfScope: [], allowedPaths: [] },
      acceptance: [{ text: "The CLI search returns the needle" }]
    });
    const rolloutPath = join(base, "sessions", "cli-search-rollout.jsonl");
    await mkdir(join(base, "sessions"), { recursive: true });
    await writeFile(rolloutPath, "{\"type\":\"session_meta\",\"payload\":{\"originator\":\"vermillion\"}}\n{\"payload\":{\"turn_id\":\"turn-cli\",\"text\":\"cli-search-needle\"}}\n", "utf8");
    await writeFile(join(base, "session-index.json"), JSON.stringify({
      version: 1,
      entries: [{
        sessionId: "session-cli-search",
        workspaceId: workspace.workspaceId,
        conversationId: "conversation-cli-search",
        engineId: "codex",
        providerKind: "codex-thread",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        metadata: { rolloutPath }
      }],
      relations: [],
      treeViews: {}
    }, null, 2), "utf8");
    const result = await call("search.query", { query: "cli-search-needle" });
    expect(result.hits.map((hit: { kind: string }) => hit.kind)).toEqual(["workItem", "session"]);
    expect(result.hits[1]).toMatchObject({ sessionId: "session-cli-search", turnId: "turn-cli" });
  });
});
