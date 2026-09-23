import { describe, expect, it, vi } from "vitest";
import { PiRuntimePort } from "../src/engines/pi/runtime-port.js";

describe("pi steering", () => {
  it.each([false, true])("starts in the same session when the turn ends before delivery (payload race: %s)", async (duringPayload) => {
    const port = new PiRuntimePort({
      engineId: "pi",
      resolveCommand: async () => { throw new Error("A unit test must not start pi"); },
      resolveSessionDirectory: () => "unused",
      resolvePiSessionId: () => "provider",
      resolveSessionCwd: async () => "unused",
      resolveExtensionPath: () => undefined
    });
    const internals = port as unknown as {
      sessions: Map<string, unknown>;
      buildImages: () => Promise<unknown[]>;
      syncRoleInstructions: () => Promise<void>;
      sendUserMessage: () => Promise<unknown>;
    };
    if (duringPayload) {
      const runtime = { process: { running: true }, streaming: true };
      internals.sessions.set("session", runtime);
      vi.spyOn(internals, "buildImages").mockImplementation(async () => {
        runtime.streaming = false;
        return [];
      });
      vi.spyOn(internals, "syncRoleInstructions").mockResolvedValue();
    }
    const start = vi.spyOn(internals, "sendUserMessage")
      .mockResolvedValue({ id: "append", ok: true, result: { sessionId: "session", turnId: "new" } });
    const request = { id: "append", method: "steerTurn" as const,
      params: { sessionId: "session", turnId: "old", messageId: "message", content: "continue" } };
    expect(await port.request(request)).toMatchObject({ ok: true, result: { sessionId: "session", turnId: "new", delivery: "start_or_steer" } });
    expect(start).toHaveBeenCalledExactlyOnceWith(request);
  });
});
