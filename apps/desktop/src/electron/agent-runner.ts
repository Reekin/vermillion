import { sessionItemId, type createSessionRuntimeService } from "@vermillion/desktop-server";
import type { AgentRunner, RoleExecutionOverrides, SessionSteerResult, SourceAsker } from "@vermillion/workbench";
import { mergeSessionExecutionProfile, resolveEngineExecutionPreference, writeSessionExecutionProfile } from "@vermillion/shared";

type SessionShell = ReturnType<typeof createSessionRuntimeService>;

const createId = (): string => "cmd-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);

type SourceAskRole = {
  cwd: string;
  modelConfig?: RoleExecutionOverrides;
};

type SourceAskRoleResolver = (workspaceId: string) => Promise<SourceAskRole>;

/** 新建会话使用设置里的默认引擎；未设置时取注册顺序的第一个。 */
const resolveDefaultEngineId = async (shell: SessionShell): Promise<string> => {
  const settings = await shell.getSettings();
  const engines = shell.listEngines();
  const preferred = settings.defaultNewSessionEngineId;
  if (preferred && engines.some((engine) => engine.engineId === preferred)) {
    return preferred;
  }
  const fallback = engines[0]?.engineId;
  if (!fallback) {
    throw new Error("No session engine is available.");
  }
  return fallback;
};

/** 已有会话树的引擎在创建时定死，fork、恢复与投递沿着该引擎进行。 */
const resolveSessionEngineId = async (
  shell: SessionShell,
  sessionId: string
): Promise<string> => {
  const engineId = shell
    .listSessions({ includeArchived: true })
    .find((session) => session.sessionId === sessionId)?.engineId;
  return engineId ?? (await resolveDefaultEngineId(shell));
};

const resolveActiveTurnId = (shell: SessionShell, sessionId: string): string | undefined =>
  shell.getActiveTurnId(sessionId) ?? shell.getSnapshot().turns
    .filter((turn) => turn.sessionId === sessionId && turn.status !== "completed")
    .at(-1)?.turnId;

const lastAssistantText = (shell: SessionShell, sessionId: string): string | undefined => {
  const snapshot = shell.getSnapshot();
  const turn = snapshot.turns.filter((entry) => entry.sessionId === sessionId).at(-1);
  if (!turn) return undefined;
  const text = snapshot.messageBlocks
    .filter((block) => block.turnId === turn.turnId && block.role === "assistant" && block.phase !== "commentary" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
  return text || undefined;
};

/** Deliver a message to an active turn, or start a new turn in the same session. */
export const createSessionSteerer = (shell: SessionShell) => async (target: string, content: string, messageId?: string): Promise<SessionSteerResult> => {
  const sessionId = shell.resolveSessionIdentifier(target);
  if (!sessionId || !await shell.ensureSessionLoadedForRead(sessionId)) {
    throw new Error("Session not found: " + target);
  }
  const activeTurnId = resolveActiveTurnId(shell, sessionId);
  const command = activeTurnId
    ? { type: "steerTurn" as const, sessionId, turnId: activeTurnId, messageId: messageId ?? createId(), content, attachments: [] }
    : { type: "sendUserMessage" as const, sessionId, messageId: messageId ?? createId(), content, attachments: [] };
  const receipt = await shell.executeCommand({ commandId: createId(), command });
  if (!receipt.accepted || !receipt.turnId) return {
    sessionId, accepted: false,
    error: receipt.error ?? { code: "message_rejected", message: "引擎未接受本次消息" }
  };
  return {
    sessionId,
    turnId: receipt.turnId,
    delivery: receipt.delivery === "steered" ? "steered" : "started"
  };
};

/** Ask the design session at a work item's recorded source position through a disposable fork. */
export const createSourceAsker = (
  shell: SessionShell,
  resolveRole: SourceAskRoleResolver
): SourceAsker => async (input) => {
  if (!await shell.ensureSessionLoadedForRead(input.sourceSessionId)) {
    throw new Error("Source session not found: " + input.sourceSessionId);
  }
  const role = await resolveRole(input.workspaceId);
  const engineId = await resolveSessionEngineId(shell, input.sourceSessionId);
  const settings = await shell.getSettings();
  const execution = mergeSessionExecutionProfile(
    resolveEngineExecutionPreference(settings.executionPreferencesByEngineId[engineId]),
    role.modelConfig
  );
  const sessionProfile = writeSessionExecutionProfile({
    role: "design-partner",
    sourceSessionId: input.sourceSessionId,
    sourceTurnId: input.sourceTurnId,
    workItemId: input.workItemId,
    asksource: true
  }, { engineId, ...execution });
  const forked = await shell.runSessionAction({
    sessionId: input.sourceSessionId,
    action: "fork",
    fromTurnId: input.sourceTurnId,
    activateFork: false,
    cwd: role.cwd,
    metadata: sessionProfile
  });
  if (forked.action !== "fork" || forked.status !== "forked") {
    throw new Error("Source ask fork unavailable: " + input.sourceSessionId);
  }

  const askSessionId = forked.forkedSessionId;
  let askTurnId: string | undefined;
  let answer: string | undefined;
  let askError: string | undefined;
  let archiveError: string | undefined;
  let unsubscribeCompleted: (() => void) | undefined;
  try {
    if (!await shell.ensureSessionLoadedForRead(askSessionId)) {
      throw new Error("Source ask fork could not be loaded: " + askSessionId);
    }
    await shell.setSessionTitle(askSessionId, "澄清 · " + input.question.slice(0, 40));
    const completed = new Promise<{ turnId: string; finishReason: string }>((resolve) => {
      unsubscribeCompleted = shell.subscribe((envelope) => {
        if (envelope.event.type === "turn.completed" && envelope.event.sessionId === askSessionId) {
          unsubscribeCompleted?.();
          unsubscribeCompleted = undefined;
          resolve({ turnId: envelope.event.turnId, finishReason: envelope.event.finishReason });
        }
      }, { eventTypes: ["turn.completed"] });
    });
    const receipt = await shell.executeCommand({
      commandId: createId(),
      command: {
        type: "sendUserMessage",
        sessionId: askSessionId,
        messageId: createId(),
        content: input.question,
        attachments: [],
        execution: {
          ...(execution.modelId ? { modelId: execution.modelId } : {}),
          ...(execution.reasoningOptionId ? { reasoningOptionId: execution.reasoningOptionId } : {}),
          ...(execution.serviceTierId !== undefined ? { serviceTierId: execution.serviceTierId } : {})
        }
      }
    });
    if (!receipt.accepted || !receipt.turnId) throw new Error("Source ask message was not accepted.");
    askTurnId = receipt.turnId;
    const result = await completed;
    askTurnId = result.turnId;
    if (result.finishReason !== "completed") throw new Error("Source ask turn ended: " + result.finishReason);
    answer = lastAssistantText(shell, askSessionId) ?? "";
  } catch (error) {
    askError = error instanceof Error ? error.message : String(error);
  } finally {
    unsubscribeCompleted?.();
    unsubscribeCompleted = undefined;
    try {
      await shell.runSessionAction({ sessionId: askSessionId, action: "archive" });
    } catch (error) {
      archiveError = error instanceof Error ? error.message : String(error);
    }
  }

  if (askError) {
    throw new Error("asksource failed: " + askError + (archiveError ? "; temporary fork archive failed: " + archiveError : "; temporary fork archived."));
  }
  if (!askTurnId) throw new Error("Source ask completed without a turn id." + (archiveError ? " Temporary fork archive failed: " + archiveError : ""));
  return {
    answer: answer ?? "",
    askSessionId,
    askTurnId,
    archived: !archiveError,
    ...(archiveError ? { archiveError } : {})
  };
};

/** Background agent sessions for the orchestrator: same engine and session list as the UI, opened headlessly. */
export const createAgentRunner = (shell: SessionShell): AgentRunner => ({
  open: async (input) => {
    const engineId = await resolveDefaultEngineId(shell);
    const settings = await shell.getSettings();
    const { sessionId } = await shell.createBrowserSession({
      workspaceId: input.workspaceId,
      engineId,
      sessionProfile: mergeSessionExecutionProfile(
        resolveEngineExecutionPreference(settings.executionPreferencesByEngineId[engineId]),
        input.modelConfig
      ),
      metadata: { ...input.metadata, cwd: input.cwd }
    });
    await shell.setSessionTitle(sessionId, input.title);
    return { sessionId };
  },
  fork: async (input) => {
    if (!await shell.ensureSessionLoadedForRead(input.sourceSessionId)) throw new Error("Source session not found");
    const engineId = await resolveSessionEngineId(shell, input.sourceSessionId);
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
      cwd: workspace.absolutePath,
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
    const messageId = options?.messageId ?? createId();
    const receipt = await shell.executeCommand({
      commandId: createId(),
      command: { type: "sendUserMessage", sessionId, messageId, content,
        attachments: options?.attachments ?? [], execution: options?.execution }
    });
    if (!receipt.accepted) return {
      accepted: false, error: receipt.error, messageId,
      turnId: receipt.turnId
    };
    return { turnId: receipt.turnId, messageId };
  },
  steer: async (sessionId, content, messageId) => {
    if (!await shell.ensureSessionLoadedForRead(sessionId)) throw new Error("Session not found: " + sessionId);
    const turnId = resolveActiveTurnId(shell, sessionId);
    const id = messageId ?? createId();
    const command = turnId
      ? { type: "steerTurn" as const, sessionId, turnId, messageId: id, content, attachments: [] }
      : { type: "sendUserMessage" as const, sessionId, messageId: id, content, attachments: [] };
    const receipt = await shell.executeCommand({ commandId: createId(), command });
    if (!receipt.accepted) return {
      accepted: false, error: receipt.error, messageId: id,
      turnId: receipt.turnId
    };
    return { turnId: receipt.turnId, messageId: id,
      delivery: receipt.delivery === "steered" ? "steered" as const : "started" as const };
  },
  interrupt: async (sessionId, expectedTurnId) => {
    const turnId = expectedTurnId ?? shell
      .getSnapshot()
      .turns.filter((t) => t.sessionId === sessionId && t.status !== "completed")
      .at(-1)?.turnId;
    if (!turnId) return;
    await shell.executeCommand({ commandId: createId(), command: { type: "interruptTurn", sessionId, turnId } });
  },
  resume: async (sessionId, options) => {
    // Background recovery must not participate in the UI's cancellable session-opening sequence.
    if (!await shell.ensureSessionLoadedForRead(sessionId)) return false;
    const { title, modelConfig, ...resumeOptions } = options ?? {};
    if (modelConfig) {
      const engineId = await resolveSessionEngineId(shell, sessionId);
      const settings = await shell.getSettings();
      resumeOptions.metadata = writeSessionExecutionProfile(resumeOptions.metadata, {
        engineId,
        ...mergeSessionExecutionProfile(resolveEngineExecutionPreference(settings.executionPreferencesByEngineId[engineId]), modelConfig)
      });
    }
    const result = await shell.runSessionAction({ sessionId, action: "resume", preserveExecution: true, ...resumeOptions });
    if (result.action !== "resume" || !result.resumed) return false;
    if (title) await shell.setSessionTitle(sessionId, title);
    return true;
  },
  isActive: (sessionId) => !!shell.getActiveTurnId(sessionId),
  getActiveTurnId: (sessionId) => shell.getActiveTurnId(sessionId),
  inspectTurn: async (sessionId, turnId) => {
    if (shell.getActiveTurnId(sessionId) === turnId) return { status: "active" };
    if (!await shell.ensureSessionLoadedForRead(sessionId, { force: true })) return { status: "unknown" };
    if (shell.getActiveTurnId(sessionId) === turnId) return { status: "active" };
    const turn = shell.getSnapshot().turns.find((entry) => entry.sessionId === sessionId && entry.turnId === turnId);
    if (turn?.status !== "completed" || !turn.finishReason) return { status: "unknown" };
    return { status: "completed", finishReason: turn.finishReason };
  },
  confirmMessage: async (sessionId, messageId) => {
    const canonicalId = sessionItemId(sessionId, messageId);
    const findAcceptedMessage = () => shell.getSnapshot().messageBlocks.find((entry) =>
      entry.sessionId === sessionId && entry.role === "user" && entry.messageId === canonicalId);
    let block = findAcceptedMessage();
    if (!block) {
      if (!await shell.ensureSessionLoadedForRead(sessionId, { force: true })) return { accepted: false };
      block = findAcceptedMessage();
    }
    return block ? { accepted: true, turnId: block.turnId, active: shell.getActiveTurnId(sessionId) === block.turnId } : { accepted: false };
  },
  onTurnStarted: (listener) => shell.subscribe(({ event }) => {
    if (event.type === "turn.started") listener({ sessionId: event.sessionId, turnId: event.turnId, messageId: event.messageId });
  }, { eventTypes: ["turn.started"] }),
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
