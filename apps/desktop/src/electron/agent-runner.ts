import type { createSessionRuntimeService } from "@vermillion/desktop-server";
import type { AgentRunner } from "@vermillion/workbench";
import { mergeSessionExecutionProfile, resolveEngineExecutionPreference, writeSessionExecutionProfile } from "@vermillion/shared";

type SessionShell = ReturnType<typeof createSessionRuntimeService>;

const createId = (): string => "cmd-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);

/** Background agent sessions for the orchestrator: same engine and session list as the UI, opened headlessly. */
export const createAgentRunner = (shell: SessionShell, engineId: string): AgentRunner => ({
  open: async (input) => {
    const settings = await shell.getSettings();
    const { sessionId } = await shell.createBrowserSession({
      workspaceId: input.workspaceId,
      engineId,
      sessionProfile: mergeSessionExecutionProfile(
        resolveEngineExecutionPreference(settings.executionPreferencesByEngineId[engineId]),
        input.modelConfig
      ),
      metadata: { ...input.metadata, cwd: input.cwd, developerInstructions: input.developerInstructions }
    });
    await shell.setSessionTitle(sessionId, input.title);
    return { sessionId };
  },
  fork: async (input) => {
    if (!await shell.ensureSessionLoadedForRead(input.sourceSessionId)) throw new Error("Source session not found");
    const workspace = (await shell.listWorkspaces()).workspaces.find((entry) => entry.workspaceId === input.workspaceId);
    if (!workspace) throw new Error("Workspace not found");
    const tree = await shell.getChatTree(input.sourceSessionId);
    const source = shell.getSnapshot();
    const turn = source.turns.find((entry) => entry.sessionId === input.sourceSessionId && entry.turnId === input.sourceTurnId);
    // A paged projection may omit this turn (including inherited turns). Codex validates lastTurnId canonically.
    if (turn && turn.status !== "completed") throw new Error("Worker fork requires a completed source turn");
    const settings = await shell.getSettings();
    const metadata = writeSessionExecutionProfile({ ...input.metadata, treeId: tree.treeId ?? input.sourceSessionId,
      sourceSessionId: input.sourceSessionId, sourceTurnId: input.sourceTurnId }, {
      engineId,
      ...mergeSessionExecutionProfile(resolveEngineExecutionPreference(settings.executionPreferencesByEngineId[engineId]), input.modelConfig)
    });
    const result = await shell.runSessionAction({
      sessionId: input.sourceSessionId, action: "fork", fromTurnId: input.sourceTurnId, activateFork: false,
      cwd: workspace.absolutePath, developerInstructions: input.developerInstructions,
      metadata
    });
    if (result.action !== "fork" || result.status !== "forked") throw new Error("Worker fork unavailable");
    const sessionId = result.forkedSessionId;
    if (!await shell.ensureSessionLoadedForRead(sessionId)) throw new Error("Worker fork could not be loaded");
    await shell.setSessionTitle(sessionId, input.title);
    return { sessionId, treeId: tree.treeId ?? input.sourceSessionId };
  },
  resolveSourceTurn: async (sessionId) => {
    if (!await shell.ensureSessionLoadedForRead(sessionId)) throw new Error("Source session not found: " + sessionId);
    await shell.getChatTree(sessionId);
    const snapshot = shell.getSnapshot();
    const session = snapshot.sessions.find((entry) => entry.sessionId === sessionId);
    if (!session) throw new Error("Source session not found: " + sessionId);
    return session.lastTurnId ?? snapshot.turns.filter((entry) => entry.sessionId === sessionId).at(-1)?.turnId
      ?? (typeof session.metadata?.sourceTurnId === "string" ? session.metadata.sourceTurnId : undefined);
  },
  send: async (sessionId, content, options) => {
    const receipt = await shell.executeCommand({
      commandId: createId(),
      command: { type: "sendUserMessage", sessionId, messageId: createId(), content,
        attachments: options?.attachments ?? [], execution: options?.execution }
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
  resume: async (sessionId, options) => {
    // Background recovery must not participate in the UI's cancellable session-opening sequence.
    if (!await shell.ensureSessionLoadedForRead(sessionId)) return false;
    try {
      const { title, modelConfig, ...resumeOptions } = options ?? {};
      if (modelConfig) {
        const settings = await shell.getSettings();
        resumeOptions.metadata = writeSessionExecutionProfile(resumeOptions.metadata, {
          engineId,
          ...mergeSessionExecutionProfile(resolveEngineExecutionPreference(settings.executionPreferencesByEngineId[engineId]), modelConfig)
        });
      }
      const result = await shell.runSessionAction({ sessionId, action: "resume", ...resumeOptions });
      if (result.action !== "resume" || !result.resumed) return false;
      if (title) await shell.setSessionTitle(sessionId, title);
      return true;
    } catch {
      return false;
    }
  },
  isActive: (sessionId) => shell.getSnapshot().turns.some((turn) => turn.sessionId === sessionId && turn.status !== "completed"),
  release: (sessionId) => shell.releaseSessionExecution(sessionId),
  onTurnCompleted: (listener) => {
    const failures = new Map<string, string>();
    return shell.subscribe(
      (envelope) => {
        const event = envelope.event;
        if (event.type === "runtime.error" && event.turnId && !event.recoverable) {
          failures.set(event.turnId, event.message);
        }
        if (event.type === "turn.completed") {
          const failure = failures.get(event.turnId);
          failures.delete(event.turnId);
          listener({ sessionId: event.sessionId, turnId: event.turnId, finishReason: event.finishReason, failure });
        }
      },
      { eventTypes: ["runtime.error", "turn.completed"] }
    );
  }
});
