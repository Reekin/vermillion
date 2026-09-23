import readline from "node:readline";

const projectPath = process.env.VERMILLION_MULTI_SESSION_PROJECT;
const sessionCount = Number(process.env.VERMILLION_MULTI_SESSION_COUNT ?? "50");
const turnsPerSession = Number(process.env.VERMILLION_MULTI_SESSION_TURNS ?? "100");
if (!projectPath || !Number.isInteger(sessionCount) || !Number.isInteger(turnsPerSession)) {
  process.stderr.write("Valid VERMILLION_MULTI_SESSION_PROJECT, COUNT, and TURNS are required\n");
  process.exit(2);
}

const startedAt = Math.floor(Date.now() / 1000);
const makeTurn = (sessionIndex, turnIndex) => {
  const threadId = `multi-session-${sessionIndex}`;
  const turnId = `${threadId}-turn-${turnIndex}`;
  return {
    id: turnId,
    items: [
      {
        type: "userMessage",
        id: `${turnId}-user`,
        content: [{ type: "text", text: `Question ${sessionIndex}:${turnIndex}`, text_elements: [] }]
      },
      {
        type: "agentMessage",
        id: `${turnId}-agent`,
        text: `Answer ${sessionIndex}:${turnIndex}`,
        phase: "final_answer",
        memoryCitation: null
      }
    ],
    itemsView: "full",
    status: "completed",
    error: null,
    startedAt: startedAt + turnIndex * 2,
    completedAt: startedAt + turnIndex * 2 + 1,
    durationMs: 1000
  };
};

const threads = Array.from({ length: sessionCount }, (_, sessionIndex) => {
  const id = `multi-session-${sessionIndex}`;
  return {
    id,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    preview: `Question ${sessionIndex}:0`,
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: "paginated",
    modelProvider: "fixture",
    model: "fixture-model",
    reasoningEffort: null,
    createdAt: startedAt + sessionIndex,
    updatedAt: startedAt + sessionIndex,
    recencyAt: startedAt + sessionIndex,
    status: { type: "notLoaded" },
    path: null,
    cwd: projectPath,
    cliVersion: "fixture",
    source: "appServer",
    threadSource: null,
    canAcceptDirectInput: true,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: `Multi session ${sessionIndex}`,
    turns: Array.from({ length: turnsPerSession }, (_, turnIndex) =>
      makeTurn(sessionIndex, turnIndex)
    )
  };
});

const clone = (value) => structuredClone(value);
const findThread = (id) => threads.find((item) => item.id === id);
const threadResponse = (thread, includeTurns) => ({
  ...clone(thread),
  turns: includeTurns ? clone(thread.turns) : [],
  status: { type: includeTurns ? "idle" : "notLoaded" }
});
const treeResponse = (thread) => ({
  version: 1,
  revision: 1,
  currentNodeId: thread.turns.at(-1)?.id ?? null,
  visibleNodeIds: thread.turns.map((turn) => turn.id),
  visibleTurnIds: thread.turns.map((turn) => turn.id),
  nodes: thread.turns.map((turn, index) => ({
    nodeId: turn.id,
    parentNodeId: index === 0 ? null : thread.turns[index - 1].id,
    turnId: turn.id,
    order: index,
    status: "completed",
    summary: turn.items[0].content[0].text
  }))
});
const send = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`);

// Optional finite live load through the same protocol as ordinary engine output.
const streamTicks = Number(process.env.VERMILLION_MULTI_SESSION_STREAM_TICKS ?? "0");
const startStreams = () => {
  const active = threads.map((thread) => {
    const turn = makeTurn(threads.indexOf(thread), turnsPerSession);
    turn.status = "inProgress";
    turn.completedAt = null;
    const message = turn.items[1];
    message.text = "";
    const command = { type: "commandExecution", id: `${turn.id}-command`, command: "fixture load",
      cwd: projectPath, status: "inProgress", commandActions: [], aggregatedOutput: "",
      exitCode: null, durationMs: null };
    turn.items.push(command);
    thread.turns.push(turn);
    send({ method: "turn/started", params: { threadId: thread.id, turn: { id: turn.id } } });
    for (const item of [message, command]) {
      send({ method: "item/started", params: { threadId: thread.id, turnId: turn.id, item } });
    }
    return { thread, turn, message, command };
  });
  let tick = 0;
  const timer = setInterval(() => {
    tick += 1;
    for (const { thread, turn, message, command } of active) {
      const delta = `${tick} `;
      message.text += delta;
      command.aggregatedOutput += delta;
      send({ method: "item/agentMessage/delta", params: {
        threadId: thread.id, turnId: turn.id, itemId: message.id, delta
      } });
      send({ method: "item/commandExecution/outputDelta", params: {
        threadId: thread.id, turnId: turn.id, itemId: command.id, delta
      } });
    }
    if (tick < streamTicks) return;
    clearInterval(timer);
    for (const { thread, turn, message, command } of active) {
      turn.status = "completed";
      turn.completedAt = Math.floor(Date.now() / 1000);
      command.status = "completed";
      command.exitCode = 0;
      for (const item of [message, command]) {
        send({ method: "item/completed", params: { threadId: thread.id, turnId: turn.id, item } });
      }
      send({ method: "turn/completed", params: { threadId: thread.id, turn } });
    }
  }, 100);
};

const handle = (request) => {
  if (request.method === "initialized") return;
  if (request.method === "initialize") {
    if (streamTicks > 0) setTimeout(startStreams, 30_000);
    send({ id: request.id, result: {
      userAgent: "vermillion-multi-session-fixture/1",
      codexHome: process.env.CODEX_HOME ?? null,
      platformFamily: process.platform,
      platformOs: process.platform
    } });
    return;
  }
  const params = request.params ?? {};
  const thread = findThread(String(params.threadId));
  switch (request.method) {
    case "thread/list":
      send({ id: request.id, result: {
        data: clone(params.cwd ? threads.filter((item) => item.cwd === params.cwd) : threads),
        nextCursor: null,
        backwardsCursor: null
      } });
      return;
    case "thread/read":
      if (!thread) return send({ id: request.id, error: { code: -32004, message: `Thread not found: ${params.threadId}` } });
      send({ id: request.id, result: { thread: threadResponse(thread, Boolean(params.includeTurns)) } });
      return;
    case "thread/resume":
      if (!thread) return send({ id: request.id, error: { code: -32004, message: `Thread not found: ${params.threadId}` } });
      send({ id: request.id, result: {
        thread: threadResponse(thread, true),
        model: "fixture-model",
        modelProvider: "fixture",
        serviceTier: null,
        cwd: projectPath,
        instructionSources: [],
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: { type: "readOnly", networkAccess: false },
        reasoningEffort: null,
        multiAgentMode: "explicitRequestOnly"
      } });
      return;
    case "thread/turns/list":
      send({ id: request.id, result: { data: clone(thread?.turns ?? []), nextCursor: null, backwardsCursor: null } });
      return;
    case "thread/goal/get":
      send({ id: request.id, result: { goal: null } });
      return;
    case "thread/unsubscribe":
      send({ id: request.id, result: { status: "unsubscribed" } });
      return;
    case "chatTree/read":
    case "chatTree/setCurrent":
      send({ id: request.id, result: {
        threadId: String(params.threadId),
        chatTree: thread ? treeResponse(thread) : {
          version: 1,
          revision: 1,
          currentNodeId: null,
          visibleNodeIds: [],
          visibleTurnIds: [],
          nodes: []
        }
      } });
      return;
    case "getAuthStatus":
      send({ id: request.id, result: { authMethod: "apikey", authToken: null, requiresOpenaiAuth: false } });
      return;
    case "config/read":
      send({ id: request.id, result: {
        config: {
          model_provider: "fixture",
          developer_instructions: null,
          model_providers: {}
        }
      } });
      return;
    case "model/list":
      send({ id: request.id, result: { data: [], nextCursor: null } });
      return;
    default:
      send({ id: request.id, result: {} });
  }
};

const reader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
reader.on("line", (line) => {
  if (!line.trim()) return;
  try {
    handle(JSON.parse(line));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  }
});
