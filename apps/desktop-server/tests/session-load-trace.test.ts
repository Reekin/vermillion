import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { DiagnosticsWriteInputRpc } from "@vermillion/shared";
import { sessionStage, traceSessionRead } from "../src/session-load-trace.js";
import { JsonRpcLineClient } from "../src/runtime/json-rpc-line-client.js";

describe("session load diagnostics", () => {
  it("keeps parallel read ownership and parent spans separate, including failure", async () => {
    const entries: DiagnosticsWriteInputRpc[] = [];
    const write = (entry: DiagnosticsWriteInputRpc) => { entries.push(entry); };
    await Promise.all([
      traceSessionRead("click-a::read", "a", write, () => sessionStage("history.convert", {}, async () => { await Promise.resolve(); })),
      traceSessionRead("click-b::read", "b", write, () => sessionStage("history.convert", {}, async () => { throw new Error("private content"); })).catch(() => {})
    ]);
    for (const sessionId of ["a", "b"]) {
      const own = entries.filter((entry) => entry.sessionId === sessionId);
      expect(own).toHaveLength(4);
      const root = own.find((entry) => entry.context?.stage === "server.read")!;
      expect(own.find((entry) => entry.context?.stage === "history.convert")?.context?.parentSpanId).toBe(root.context?.spanId);
      expect(own.every((entry) => entry.context?.traceId === `click-${sessionId}`)).toBe(true);
    }
    expect(JSON.stringify(entries)).not.toContain("private content");
  });

  it("records the engine ID, write, parsing and late response after cancellation without logging payloads", async () => {
    const entries: DiagnosticsWriteInputRpc[] = [];
    const input = new PassThrough();
    const output = new PassThrough();
    const client = new JsonRpcLineClient({ input, output, createRequestId: () => 71 });
    const controller = new AbortController();
    const request = traceSessionRead("click::read", "s", (entry) => { entries.push(entry); }, () =>
      client.request("thread/resume", { threadId: "thread", developerInstructions: "PRIVATE" }, { signal: controller.signal }));
    const rejected = request.catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await rejected;
    input.write(JSON.stringify({ id: 71, result: { private: "BODY" } }) + "\n");
    await new Promise((resolve) => setImmediate(resolve));
    const response = entries.find((entry) => entry.context?.phase === "response");
    expect(response?.context).toMatchObject({ engineRequestId: "71", late: true, traceId: "click" });
    expect(response?.context?.responseBytes).toBeGreaterThan(0);
    expect(entries.some((entry) => entry.context?.phase === "sent")).toBe(true);
    expect(JSON.stringify(entries)).not.toMatch(/PRIVATE|BODY/);
    client.dispose();
  });

  it("does not let a failing diagnostic sink fail the operation", async () => {
    await expect(traceSessionRead("r", "s", () => { throw new Error("log full"); }, async () => 42)).resolves.toBe(42);
  });
});
