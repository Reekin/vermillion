import { describe, expect, it } from "vitest";
import { defaultDomainConfig, parseDomainDefinition } from "../src/domains.js";
import { createWorkbenchRpcHandler } from "../src/rpc-handler.js";
import { createWorkbenchClient } from "../src/rpc.js";
import { ServiceError, renderServiceText, renderServiceTexts, serviceError, text } from "../src/service-text.js";
import type { WorkbenchService } from "../src/workbench-service.js";

describe("workbench reasons as codes", () => {
  it("renders codes as English and keeps written text as it is", () => {
    expect(renderServiceText(text("waiting.concurrency", { occupied: 2, max: 2 }))).toBe("Waiting for a free Worker slot (2/2).");
    expect(renderServiceText("旧的中文记录")).toBe("旧的中文记录");
    expect(renderServiceTexts({ waiting: [text("dispatch.concurrency"), "engine text"], note: { code: "custom", message: "kept" } }))
      .toEqual({ waiting: ["No free execution slot yet.", "engine text"], note: { code: "custom", message: "kept" } });
  });

  it("returns the code of a rejected call with its English message", async () => {
    const service = { pauseWork: async () => { throw serviceError("error.workNotPausable"); } } as unknown as WorkbenchService;
    const handler = createWorkbenchRpcHandler(service);
    const response = await handler({ method: "work.pause", params: { workspaceId: "ws", requestId: "work-1" } });
    expect(response).toMatchObject({ ok: false, text: { code: "error.workNotPausable" } });
    expect(response.ok || response.error).toContain("This work cannot be paused.\nNext:");
    const described = createWorkbenchClient({ request: handler, onEvent: () => () => undefined }, (value) => "localized " + value.code);
    await expect(described.request("work.pause", { workspaceId: "ws", requestId: "work-1" })).rejects.toThrow("localized error.workNotPausable");
    expect(new ServiceError(text("error.workNotPausable")).message).toBe("This work cannot be paused.");
  });

  it("summarizes a domain from its first paragraph under any heading", () => {
    const config = defaultDomainConfig("ux", new Date().toISOString());
    expect(parseDomainDefinition(".vermillion/docs/domains/ux.md", "# UX\n\n## Scope\n\nScreens and\ninteraction.\n\n## When\n\nLater.\n", config).summary)
      .toBe("Screens and interaction.");
    expect(parseDomainDefinition(".vermillion/docs/domains/ux.md", "---\nstandards: []\n---\n# UX\n\n桌面界面。\n", config).summary).toBe("桌面界面。");
  });
});
