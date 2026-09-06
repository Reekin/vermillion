import type { createSessionRuntimeService } from "@vermillion/desktop-server";
import type { AgentRunner, SessionAsk } from "@vermillion/workbench";

type SessionShell = ReturnType<typeof createSessionRuntimeService>;

const createId = (): string => "cmd-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);

const turnAssistantTexts = (shell: SessionShell, sessionId: string, includeCommentary: boolean): string[] => {
  const snapshot = shell.getSnapshot();
  const turn = snapshot.turns.filter((t) => t.sessionId === sessionId).at(-1);
  if (!turn) return [];
  return snapshot.messageBlocks
    .filter((b) => b.turnId === turn.turnId && b.role === "assistant" && (includeCommentary || b.phase !== "commentary") && typeof b.text === "string" && b.text.trim())
    .map((b) => b.text!.trim());
};

const lastAssistantText = (shell: SessionShell, sessionId: string): string | undefined => {
  const text = turnAssistantTexts(shell, sessionId, false).join("\n").trim();
  return text || undefined;
};

/**
 * One question into a throwaway fork of a session: the fork keeps the original's full context, the original never
 * sees the question. The fork is archived afterwards so it does not linger in the sidebar.
 */
export const createSessionAsk = (shell: SessionShell): SessionAsk => async ({ sessionId, question }) => {
  const forked = await shell.runSessionAction({ sessionId, action: "fork" });
  if (forked.action !== "fork" || forked.status !== "forked") throw new Error("Could not fork session " + sessionId);
  const child = forked.forkedSessionId;
  await shell.openSession(child); // discovered fork -> loaded, executable session
  await shell.setSessionTitle(child, "澄清 · " + question.slice(0, 40));
  const done = new Promise<void>((resolve) => {
    const off = shell.subscribe(
      (envelope) => {
        if (envelope.event.type === "turn.completed" && envelope.event.sessionId === child) { off(); resolve(); }
      },
      { eventTypes: ["turn.completed"] }
    );
  });
  const receipt = await shell.executeCommand({
    commandId: createId(),
    command: { type: "sendUserMessage", sessionId: child, messageId: createId(), content: question, attachments: [] }
  });
  if (!receipt.accepted) throw new Error("ask rejected for " + child);
  await done;
  const answer = lastAssistantText(shell, child) ?? "";
  await shell.runSessionAction({ sessionId: child, action: "archive" }).catch(() => undefined);
  return answer;
};

/** Background agent sessions for the orchestrator: same engine and session list as the UI, opened headlessly. */
export const createAgentRunner = (shell: SessionShell, engineId: string): AgentRunner => ({
  open: async (input) => {
    const { sessionId } = await shell.createBrowserSession({
      workspaceId: input.workspaceId,
      engineId,
      metadata: { ...input.metadata, cwd: input.cwd, developerInstructions: input.developerInstructions }
    });
    await shell.setSessionTitle(sessionId, input.title);
    return { sessionId };
  },
  send: async (sessionId, content) => {
    const receipt = await shell.executeCommand({
      commandId: createId(),
      command: { type: "sendUserMessage", sessionId, messageId: createId(), content, attachments: [] }
    });
    if (!receipt.accepted) throw new Error("sendUserMessage rejected for " + sessionId);
  },
  steer: async (sessionId, content) => {
    const turn = shell
      .getSnapshot()
      .turns.filter((t) => t.sessionId === sessionId && t.status !== "completed")
      .at(-1);
    const command = turn
      ? { type: "steerTurn" as const, sessionId, turnId: turn.turnId, messageId: createId(), content, attachments: [] }
      : { type: "sendUserMessage" as const, sessionId, messageId: createId(), content, attachments: [] };
    const receipt = await shell.executeCommand({ commandId: createId(), command });
    if (!receipt.accepted) throw new Error("steer rejected for " + sessionId);
    return { turnId: turn?.turnId };
  },
  interrupt: async (sessionId) => {
    const turn = shell
      .getSnapshot()
      .turns.filter((t) => t.sessionId === sessionId && t.status !== "completed")
      .at(-1);
    if (!turn) return;
    await shell.executeCommand({ commandId: createId(), command: { type: "interruptTurn", sessionId, turnId: turn.turnId } });
  },
  resume: async (sessionId) => {
    try {
      await shell.openSession(sessionId);
      return true;
    } catch {
      return false;
    }
  },
  lastReply: (sessionId) => lastAssistantText(shell, sessionId),
  turnMessages: (sessionId) => turnAssistantTexts(shell, sessionId, true),
  registerTool: (tool) => {
    shell.hostTools?.register({
      namespace: "vermillion",
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as never,
      isAvailable: (context) => shell.getSessionMetadata(context.sessionId)?.role === tool.role,
      handle: async (invocation) => {
        try {
          const text = await tool.handle((invocation.arguments ?? {}) as Record<string, unknown>, invocation.context.sessionId);
          return { contentItems: [{ type: "inputText", text }], success: true };
        } catch (error) {
          return { contentItems: [{ type: "inputText", text: error instanceof Error ? error.message : String(error) }], success: false };
        }
      }
    });
  },
  onTurnCompleted: (listener) =>
    shell.subscribe(
      (envelope) => {
        if (envelope.event.type === "turn.completed") listener({ sessionId: envelope.event.sessionId, turnId: envelope.event.turnId, finishReason: envelope.event.finishReason });
      },
      { eventTypes: ["turn.completed"] }
    )
});
