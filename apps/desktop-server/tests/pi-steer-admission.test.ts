import { describe, expect, it, vi } from "vitest";
import { PiRuntimePort } from "../src/engines/pi/runtime-port.js";

const makePort = () => new PiRuntimePort({
  engineId: "pi",
  resolveCommand: async () => { throw new Error("A unit test must not start pi"); },
  resolveSessionDirectory: () => "unused",
  resolvePiSessionId: () => "provider",
  resolveSessionCwd: async () => "unused",
  resolveExtensionPath: () => undefined
});
const request = { id: "append", method: "steerTurn" as const, params: {
  sessionId: "worker", turnId: "old", content: "continue", allowStart: false
} };

describe("pi steering admission", () => {
  it("does not create an idle session when the grant only permits steering", async () => {
    const port = makePort();
    expect(await port.request(request)).toMatchObject({ ok: false, error: { code: "execution_readmission_required" } });
  });

  it("rechecks activity after preparing the steering payload", async () => {
    const port = makePort();
    const internals = port as unknown as {
      sessions: Map<string, unknown>;
      buildImages: () => Promise<unknown[]>;
      syncRoleInstructions: () => Promise<void>;
      sendUserMessage: () => Promise<unknown>;
    };
    const runtime = { process: { running: true }, streaming: true };
    internals.sessions.set("worker", runtime);
    vi.spyOn(internals, "buildImages").mockImplementation(async () => { runtime.streaming = false; return []; });
    vi.spyOn(internals, "syncRoleInstructions").mockResolvedValue();
    const start = vi.spyOn(internals, "sendUserMessage");
    expect(await port.request(request)).toMatchObject({ ok: false, error: { code: "execution_readmission_required" } });
    expect(start).not.toHaveBeenCalled();
  });

  it("reports a start-or-steer outcome when a new turn was admitted", async () => {
    const port = makePort();
    const start = vi.spyOn(port as unknown as { sendUserMessage: () => Promise<unknown> }, "sendUserMessage")
      .mockResolvedValue({ id: "append", ok: true, result: { sessionId: "worker", turnId: "new" } });
    expect(await port.request({ ...request, params: { ...request.params, allowStart: true } }))
      .toMatchObject({ ok: true, result: { turnId: "new", delivery: "start_or_steer" } });
    expect(start).toHaveBeenCalledOnce();
  });
});
