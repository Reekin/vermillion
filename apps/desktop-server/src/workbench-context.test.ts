import { expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAdapter } from "@vermillion/adapters";
import { DomainService } from "./domain-service.js";
import { RuntimeOrchestrator } from "./runtime-orchestrator.js";
import { createCodexAppServerRuntimePort } from "./codex-app-server-runtime-port.js";

it.each([undefined, "worker"])("delivers wrapper identity for role %s", async (role) => {
  const directory = mkdtempSync(join(tmpdir(), "vermillion-context-"));
  const requestLog = join(directory, "requests.jsonl");
  const port = createCodexAppServerRuntimePort({
    commandPath: process.execPath,
    commandArgs: [fileURLToPath(new URL("../tests/fixtures/fake-codex-app-server.mjs", import.meta.url))],
    resolveConversationIdBySessionId: () => "conversation-context"
  });
  const adapter = new CodexAdapter({ runtimePort: port });
  let orchestrator: RuntimeOrchestrator;
  const domainService = new DomainService({
    now: () => "2026-09-07T00:00:00Z",
    createSessionId: () => "session-wrapper-context",
    assertEngineRegistered: (id) => orchestrator.assertEngineRegistered(id),
    resolveEngineCapabilities: (id) => orchestrator.getEngineCapabilities(id) ?? [],
    publishRuntimeEvent: () => {}
  });
  orchestrator = new RuntimeOrchestrator({
    domainService,
    sessionIndexSyncService: {
      syncSession: vi.fn().mockResolvedValue(undefined),
      syncRelation: vi.fn().mockResolvedValue(undefined),
      markSessionUnreadCompleted: vi.fn().mockResolvedValue(undefined)
    } as never,
    workspaceSelectionService: {
      activateSelection: vi.fn().mockResolvedValue(undefined),
      selectWorkspace: vi.fn().mockResolvedValue({ workspaceId: "workspace-context" })
    } as never,
    publishRuntimeEvent: () => {},
    createConversationId: () => "conversation-context",
    agentBindings: [{ descriptor: { engineId: "codex", displayName: "Codex", capabilities: ["chat"] }, adapter }]
  });
  try {
    await port.start({ env: { FAKE_CODEX_REQUEST_LOG: requestLog } });
    const session = await orchestrator.createSession({ engineId: "codex", workspaceId: "workspace-context", metadata: role ? { role } : {} });
    await orchestrator.executeCommand({
      commandId: "send-context",
      command: { type: "sendUserMessage", sessionId: session.sessionId, messageId: "message-context", content: "hello", attachments: [] }
    });
    const requests = readFileSync(requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const injected = requests.find((request) => request.method === "thread/inject_items");
    expect(injected.params.items[0]).toMatchObject({ role: "developer" });
    expect(injected.params.items[0].content[0].text).toBe([
      "当前工作台会话（wrapper ID，用于 CLI）：",
      "sessionId: session-wrapper-context",
      "workspaceId: workspace-context"
    ].join("\n"));
    expect(requests.findIndex((request) => request.method === "thread/inject_items"))
      .toBeLessThan(requests.findIndex((request) => request.method === "turn/start"));
  } finally {
    await orchestrator.dispose();
    await port.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
