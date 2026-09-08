import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";
import { startLocalEndpoint } from "../src/local-endpoint.js";
import { AppLauncher, resolveAppCommand } from "../src/app-launcher.js";
import { fileURLToPath } from "node:url";

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.VERMILLION_PERSISTENCE_BASE_DIR;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("vermillion cli", () => {
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
    dirs.push(base);
    process.env.VERMILLION_PERSISTENCE_BASE_DIR = base;
    const endpointHandler = vi.fn(async () => ({ ok: false as const, error: "old desktop" }));
    const endpoint = await startLocalEndpoint(base, endpointHandler);
    const start = vi.spyOn(AppLauncher.prototype, "start").mockResolvedValue({ pid: 123, cdpUrl: "http://127.0.0.1:19671", desktop: "vermillion-qa" });
    const stop = vi.spyOn(AppLauncher.prototype, "stop").mockResolvedValue();
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { out.push(String(chunk)); return true; });
    try {
      expect(await runCli(["app.start", JSON.stringify({ dataDir: base, port: 19671 })])).toBe(0);
      expect(start).toHaveBeenCalledWith({ dataDir: base, port: 19671 });
      expect(start.mock.instances[0]).toMatchObject({ command: resolveAppCommand(fileURLToPath(new URL("..", import.meta.url))) });
      expect(JSON.parse(out.pop()!).pid).toBe(123);
      expect(await runCli(["app.stop", '{"pid":123}'])).toBe(0);
      expect(stop).toHaveBeenCalledWith(123);
      expect(endpointHandler).not.toHaveBeenCalled();
    } finally {
      await endpoint.close();
    }
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
});
