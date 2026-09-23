import { afterEach, expect, it, vi } from "vitest";
import type { SessionSteerer, SourceAsker } from "../src/workbench-service.js";
import { createWorkbenchClient } from "../src/rpc.js";
import { createWorkbenchRpcHandler } from "../src/rpc-handler.js";
import { WorkbenchService } from "../src/workbench-service.js";
import { contract, setup } from "./workflow-fixture.js";

const fixtures: Awaited<ReturnType<typeof setup>>[] = [];
const services: WorkbenchService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose();
  for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});

it("allows only the bound Worker to ask its work item's recorded source", async () => {
  const fixture = await setup();
  fixtures.push(fixture);
  const sourceAsker: SourceAsker = vi.fn(async (input) => ({
    answer: "Use the source contract.",
    askSessionId: "ask-session",
    askTurnId: "ask-turn",
    archived: true
  })) as unknown as SourceAsker;
  const service = new WorkbenchService({ ...fixture.options, sourceAsker });
  services.push(service);
  const client = createWorkbenchClient({ request: createWorkbenchRpcHandler(service), onEvent: (listener) => service.subscribe(listener) });
  const item = await service.createWorkItem(fixture.workspaceId, {
    ...contract,
    sessionId: "worker",
    sourceSessionId: "design-session",
    sourceTurnId: "design-turn"
  });
  await service.startWorkItem(fixture.workspaceId, item.workItemId, { sessionId: "worker", heartbeatAt: "2026-06-06T00:00:00.000Z" });

  const result = await client.request("asksource", {
    workspaceId: fixture.workspaceId,
    workItemId: item.workItemId,
    sessionId: "worker",
    question: "Which contract applies?"
  });

  expect(result).toMatchObject({ answer: "Use the source contract.", askSessionId: "ask-session", askTurnId: "ask-turn", archived: true });
  expect(sourceAsker).toHaveBeenCalledWith({
    workspaceId: fixture.workspaceId,
    workItemId: item.workItemId,
    sourceSessionId: "design-session",
    sourceTurnId: "design-turn",
    question: "Which contract applies?"
  });
  await expect(client.request("asksource", {
    workspaceId: fixture.workspaceId,
    workItemId: item.workItemId,
    sessionId: "other-session",
    question: "Try to ask"
  })).rejects.toThrow("当前 Worker");
});

it("routes generic steer through the session port and returns its delivery mode", async () => {
  const fixture = await setup();
  fixtures.push(fixture);
  const sessionSteerer: SessionSteerer = vi.fn(async (input) => ({
    sessionId: input.sessionId,
    turnId: input.sessionId === "active" ? "active-turn" : "started-turn",
    delivery: input.sessionId === "active" ? "steered" : "started"
  }));
  const service = new WorkbenchService({ ...fixture.options, sessionSteerer });
  services.push(service);
  const client = createWorkbenchClient({ request: createWorkbenchRpcHandler(service), onEvent: () => () => {} });
  const item = await service.createWorkItem(fixture.workspaceId, { ...contract, sessionId: "idle" });
  await service.startWorkItem(fixture.workspaceId, item.workItemId, { sessionId: "idle" });
  await service.pauseWorkItem(fixture.workspaceId, { workItemId: item.workItemId });
  const before = await service.getWorkItem(fixture.workspaceId, item.workItemId);

  await expect(client.request("steer", { sessionId: "active", content: "Continue the current turn." })).resolves.toMatchObject({
    sessionId: "active",
    turnId: "active-turn",
    delivery: "steered"
  });
  await expect(client.request("steer", { sessionId: "idle", content: "Start a new turn." })).resolves.toMatchObject({
    sessionId: "idle",
    turnId: "started-turn",
    delivery: "started"
  });
  expect(sessionSteerer).toHaveBeenNthCalledWith(1, expect.objectContaining({ sessionId: "active", content: "Continue the current turn.", messageId: expect.any(String) }));
  expect(sessionSteerer).toHaveBeenNthCalledWith(2, expect.objectContaining({ sessionId: "idle", content: "Start a new turn.", messageId: expect.any(String) }));
  expect(await service.getWorkItem(fixture.workspaceId, item.workItemId)).toEqual(before);
});
