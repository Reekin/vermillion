import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSession } from "@vermillion/shared";
import { useComposerController } from "../src/ui/chat-shell/use-composer-controller.js";

// The desktop suite runs in Node. This hook runner retains state and runs effects
// across explicit renders, including navigation while transport calls are pending.
const hooks = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  dirty: false,
  effects: [] as Array<() => void>,
  cleanups: [] as Array<(() => void) | void>
}));

vi.mock("react", () => ({
  useState(initial: unknown) {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) {
      hooks.slots[index] = typeof initial === "function" ? initial() : initial;
    }
    return [hooks.slots[index], (update: unknown) => {
      const next = typeof update === "function" ? update(hooks.slots[index]) : update;
      if (!Object.is(next, hooks.slots[index])) hooks.dirty = true;
      hooks.slots[index] = next;
    }];
  },
  useRef(initial: unknown) {
    const index = hooks.cursor++;
    return hooks.slots[index] ??= { current: initial };
  },
  useMemo(compute: () => unknown) { return compute(); },
  useEffect(effect: () => (() => void) | void, deps: unknown[]) {
    const index = hooks.cursor++;
    const previous = hooks.slots[index] as unknown[] | undefined;
    if (previous && deps.every((value, i) => Object.is(value, previous[i]))) return;
    hooks.slots[index] = deps;
    hooks.effects.push(() => {
      hooks.cleanups[index]?.();
      hooks.cleanups[index] = effect();
    });
  }
}));

const attachment = {
  attachment: { attachmentId: "image", name: "image.png", mimeType: "image/png", uri: "file:///image.png" },
  displayName: "image.png", dedupeKey: "image", isImage: true,
  mimeType: "image/png", size: 1, sizeLabel: "1 B", releasePreviewUrl: false
};

vi.mock("../src/ui/chat-shell/composer-attachments.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/ui/chat-shell/composer-attachments.js")>(),
  createComposerAttachments: vi.fn(async () => [attachment])
}));

type Input = Parameters<typeof useComposerController>[0];
const session = (sessionId: string, status: ChatSession["status"] = "idle"): ChatSession => ({
  sessionId, status, engineId: "test", conversationId: sessionId,
  createdAt: "2026-01-01", updatedAt: "2026-01-01"
});

const setup = (overrides: Partial<Input> = {}) => {
  const send = vi.fn(async () => ({ accepted: true }));
  const steer = vi.fn(async () => ({ accepted: true }));
  let input: Input = {
    transport: {
      chat: { send, steer, getCapabilities: async () => ({ supportsSteer: false, supportsAttachments: true, slashSuggestions: [] }) },
      skills: { list: async () => [{ name: "review", path: "/review", scope: "user", enabled: true, description: "Review" }] },
      engine: { listModels: async () => ({ models: [
        { modelId: "one", displayName: "One", isDefault: true, reasoningOptions: [], serviceTiers: [] },
        { modelId: "two", displayName: "Two", reasoningOptions: [], serviceTiers: [] }
      ] }) }
    } as unknown as Input["transport"],
    selectedEngineId: "test", contentDraftKey: "think",
    activeSessionId: "a", activeSession: session("a"),
    engineSurface: { sharedCapabilities: ["turnConfiguration", "attachments"] } as Input["engineSurface"],
    turns: [], interruptTurns: [], approvals: [], isOpeningSelectedSession: false,
    autoSendQueuedMessages: false, onStatusNotice: vi.fn(), ...overrides
  };
  let controller: ReturnType<typeof useComposerController>;
  const render = (patch: Partial<Input> = {}) => {
    input = { ...input, ...patch };
    do {
      hooks.dirty = false;
      hooks.cursor = 0;
      controller = useComposerController(input);
      hooks.effects.splice(0).forEach((effect) => effect());
    } while (hooks.dirty);
    return controller;
  };
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); return render(); };
  render();
  return { render, flush, send, steer };
};

beforeEach(() => {
  hooks.cleanups.forEach((cleanup) => cleanup?.());
  hooks.slots = []; hooks.effects = []; hooks.cleanups = []; hooks.cursor = 0;
});

describe("composer content lifetime", () => {
  it("keeps text, skills and attachments through nodes, trees and the opening gap", async () => {
    const h = setup({ draftKey: "a:node-1" });
    let c = await h.flush();
    c.onDraftChange("$review");
    c = h.render();
    await c.onSuggestionSelect(c.suggestions!.items[0]!);
    c = h.render();
    c.onDraftChange("unfinished");
    c.onComposerDrop({ preventDefault() {}, dataTransfer: { types: ["Files"], files: [{}] } } as Parameters<typeof c.onComposerDrop>[0]);
    c = await h.flush();
    expect(c.attachments).toHaveLength(1);
    expect(c.selectedSkills).toHaveLength(1);
    for (const patch of [
      { draftKey: "a:node-2" },
      { draftKey: undefined, activeSessionId: undefined, activeSession: undefined, isOpeningSelectedSession: true },
      { draftKey: "b:node-1", activeSessionId: "b", activeSession: session("b"), isOpeningSelectedSession: false }
    ]) {
      c = h.render(patch);
      expect(c.draft).toBe("unfinished");
      expect(c.selectedSkills).toHaveLength(1);
      expect(c.attachments).toHaveLength(1);
    }
    h.send.mockResolvedValueOnce({ accepted: false });
    await c.onSubmitWithInstruction("Start the work.");
    c = h.render();
    expect(c.draft).toBe("unfinished");
    expect(c.selectedSkills).toHaveLength(1);
    expect(c.attachments).toHaveLength(1);
    await c.onSubmitWithInstruction("Start the work.");
    expect(h.send).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: "b", content: "[$review](/review)\n\nunfinished\n\nStart the work.",
      attachments: [attachment.attachment]
    }));
    c = h.render();
    expect(c.draft).toBe("");
    expect(c.selectedSkills).toEqual([]);
    expect(c.attachments).toEqual([]);
  });

  it("retains per-session model selection and queues with a shared buffer", async () => {
    const h = setup({ activeSession: session("a", "running") });
    let c = await h.flush();
    c.onModelChange("two");
    c.onDraftChange("queued");
    c = h.render();
    await c.onSubmitWithInstruction("Start the work.");
    c = h.render();
    expect(c.queue[0]?.text).toBe("queued\n\nStart the work.");
    expect(c.draft).toBe("");
    c = h.render({ activeSessionId: "b", activeSession: session("b") });
    expect(c.queue).toEqual([]);
    expect(c.execution?.modelId).toBe("one");
    c = h.render({ activeSessionId: "a", activeSession: session("a", "running") });
    expect(c.execution?.modelId).toBe("two");
    expect(c.queue).toHaveLength(1);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("clears the shared buffer when first send finishes after the created session activates", async () => {
    let finish!: (value: string) => void;
    const createSession = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    const h = setup({ activeSessionId: undefined, activeSession: undefined, createSession });
    let c = await h.flush();
    c.onDraftChange("first");
    c = h.render();
    const pending = c.onPrimaryAction();
    h.render({ activeSessionId: "created", activeSession: session("created") });
    finish("created");
    await pending;
    c = h.render();
    expect(c.draft).toBe("");
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "created", content: "first" }));
    expect(h.render({ activeSessionId: undefined, activeSession: undefined }).draft).toBe("");
  });

  it("appends explicit instructions without interpreting slash commands, preserving content on rejection", async () => {
    const h = setup();
    let c = await h.flush();
    c.onDraftChange("/goal discuss this");
    c = h.render();
    h.send.mockResolvedValueOnce({ accepted: false });
    await c.onSubmitWithInstruction("Start the work.");
    c = h.render();
    expect(c.draft).toBe("/goal discuss this");
    await c.onSubmitWithInstruction("Start the work.");
    expect(h.send).toHaveBeenLastCalledWith(expect.objectContaining({ content: "/goal discuss this\n\nStart the work." }));
    expect(h.render().draft).toBe("");
  });

  it.each(["text", "skill", "attachment"])("preserves the edited buffer when a delayed send accepts after navigation (%s)", async (edit) => {
    const h = setup();
    let c = await h.flush();
    c.onDraftChange("$review");
    c = h.render();
    await c.onSuggestionSelect(c.suggestions!.items[0]!);
    c = h.render();
    c.onDraftChange("submitted");
    c.onComposerDrop({ preventDefault() {}, dataTransfer: { types: ["Files"], files: [{}] } } as Parameters<typeof c.onComposerDrop>[0]);
    c = await h.flush();
    let accept!: (receipt: { accepted: boolean }) => void;
    h.send.mockImplementationOnce(() => new Promise((resolve) => { accept = resolve; }));
    const pending = c.onSubmitWithInstruction("Start the work.");
    c = h.render({ activeSessionId: "b", activeSession: session("b"), draftKey: "b:node" });
    if (edit === "text") c.onDraftChange("new unsent input");
    if (edit === "skill") c.onRemoveSkill(c.selectedSkills[0]!.id);
    if (edit === "attachment") c.onRemoveAttachment("image");
    c = h.render();
    const expected = { draft: c.draft, skills: c.selectedSkills, attachments: c.attachments };
    accept({ accepted: true });
    await pending;
    c = h.render();
    expect({ draft: c.draft, skills: c.selectedSkills, attachments: c.attachments }).toEqual(expected);
    expect(c.draft).toBe(edit === "text" ? "new unsent input" : "submitted");
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "a", content: "[$review](/review)\n\nsubmitted\n\nStart the work."
    }));
  });

  it("keeps the existing session-keyed text behavior when no content key is supplied", async () => {
    const h = setup({ contentDraftKey: undefined });
    let c = await h.flush();
    c.onDraftChange("only a");
    c = h.render({ activeSessionId: "b", activeSession: session("b") });
    expect(c.draft).toBe("");
    expect(h.render({ activeSessionId: "a", activeSession: session("a") }).draft).toBe("only a");
  });

  it("uses steer for explicit instructions during a steer-capable turn", async () => {
    const h = setup({ activeSession: { ...session("a", "running"), lastTurnId: "turn" }, allowSessionLastTurnFallback: true });
    let c = await h.flush();
    c = h.render({ transport: {
      chat: { steer: h.steer, getCapabilities: async () => ({ supportsSteer: true, supportsAttachments: true, slashSuggestions: [] }) },
      skills: { list: async () => [] }, engine: { listModels: async () => ({ models: [] }) }
    } as unknown as Input["transport"] });
    c = await h.flush();
    c.onDraftChange("adjust scope");
    c = h.render();
    expect(c.intent).toBe("steer");
    await c.onSubmitWithInstruction("Start the work.");
    expect(h.steer).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "a", turnId: "turn", content: "adjust scope\n\nStart the work."
    }));
    expect(h.render().draft).toBe("");
  });
});
