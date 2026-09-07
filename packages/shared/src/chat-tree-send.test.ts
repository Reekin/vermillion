import { describe, expect, it } from "vitest";
import { parseSessionRpcRequest, parseSessionRpcResponse } from "./ipc.js";

describe("branch send RPC contracts", () => {
  const input = { sessionId: "root", nodeId: "turn-a", content: "",
    attachments: [{ attachmentId: "image", mimeType: "image/png", uri: "file:///image.png",
      displayUri: "image.png", name: "image.png" }],
    execution: { modelId: "model", reasoningOptionId: "high", serviceTierId: null }, thinkMode: "execute" };

  it("preserves attachment-only submissions and execution options through request and operation responses", () => {
    expect(parseSessionRpcRequest({ id: "request", method: "chatTree.submit", params: input }).params).toEqual(input);
    for (const status of ["creating", "sending", "sent", "failed"] as const) {
      const operation = { ...input, operationId: "operation", status, targetSessionId: "branch",
        ...(status === "sent" ? { turnId: "new-turn" } : {}),
        ...(status === "failed" ? { error: "provider unavailable" } : {}) };
      for (const method of ["chatTree.submit", "chatTree.retry", "chatTree.operations"]) {
        const result = method === "chatTree.operations" ? { operations: [operation] } : operation;
        expect(parseSessionRpcResponse({ id: "request", method, ok: true, result })).toEqual({ id: "request", method, ok: true, result });
      }
    }
  });

  it("requires the origin node and operation identity and defaults omitted attachments", () => {
    expect(parseSessionRpcRequest({ id: "request", method: "chatTree.submit",
      params: { sessionId: "root", nodeId: "a", content: "question" } }).params).toEqual({
      sessionId: "root", nodeId: "a", content: "question", attachments: []
    });
    expect(() => parseSessionRpcRequest({ id: "request", method: "chatTree.submit",
      params: { sessionId: "root", content: "question" } })).toThrow();
    expect(() => parseSessionRpcRequest({ id: "request", method: "chatTree.retry", params: { operationId: "" } })).toThrow();
    expect(parseSessionRpcRequest({ id: "request", method: "chatTree.retry", params: { operationId: "operation" } }).params)
      .toEqual({ operationId: "operation" });
  });
});
