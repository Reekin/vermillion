import readline from "node:readline";

const projectPath = process.env.VERMILLION_SESSION_TREE_FIXTURE_PROJECT;
if (!projectPath) {
  process.stderr.write("VERMILLION_SESSION_TREE_FIXTURE_PROJECT is required\n");
  process.exit(2);
}

const now = Math.floor(Date.now() / 1000);

const makeTurn = (threadId, suffix, question, answer) => ({
  id: `turn-${threadId}`,
  items: [
    {
      type: "userMessage",
      id: `user-${threadId}`,
      content: [{ type: "text", text: question, text_elements: [] }]
    },
    {
      type: "agentMessage",
      id: `agent-${threadId}`,
      text: answer,
      phase: "final_answer",
      memoryCitation: null
    }
  ],
  itemsView: "full",
  status: "completed",
  error: null,
  startedAt: now + suffix,
  completedAt: now + suffix + 1,
  durationMs: 1000
});

const makeThread = (id, name, preview, source, turn) => ({
  id,
  sessionId: id,
  forkedFromId: null,
  parentThreadId: null,
  preview,
  ephemeral: false,
  section: null,
  sectionEnteredAt: null,
  projectId: null,
  historyMode: "paginated",
  modelProvider: "fixture",
  model: "fixture-model",
  reasoningEffort: null,
  createdAt: now,
  updatedAt: now,
  recencyAt: now,
  status: { type: "notLoaded" },
  path: null,
  cwd: projectPath,
  cliVersion: "fixture",
  source,
  threadSource: null,
  canAcceptDirectInput: true,
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  name,
  turns: [turn]
});

const parentTurn = makeTurn(
  "fixture-parent",
  0,
  "Fixture parent question",
  "Fixture parent history is ready to read."
);
const childTurn = makeTurn(
  "fixture-child",
  1,
  "Fixture child question",
  "Fixture child history is ready to read."
);
const plainTurn = makeTurn(
  "fixture-plain",
  2,
  "Fixture plain question",
  "Fixture plain history is ready to read."
);

const threads = [
  makeThread("fixture-parent", "Fixture parent session", "Fixture parent question", "appServer", parentTurn),
  makeThread(
    "fixture-child",
    "Fixture child session",
    "Fixture child question",
    {
      subAgent: {
        thread_spawn: {
          parent_thread_id: "fixture-parent",
          depth: 1,
          agent_path: null,
          agent_nickname: null,
          agent_role: null
        }
      }
    },
    childTurn
  ),
  makeThread("fixture-plain", "Fixture plain session", "Fixture plain question", "appServer", plainTurn)
];

const clone = (value) => structuredClone(value);
const thread = (id) => threads.find((item) => item.id === id);
const threadForResponse = (item, includeTurns) => ({
  ...clone(item),
  turns: includeTurns ? clone(item.turns) : [],
  status: { type: includeTurns ? "idle" : "notLoaded" }
});
const chatTree = (item) => {
  const turn = item.turns[0];
  return {
    version: 1,
    revision: 1,
    currentNodeId: turn?.id ?? null,
    visibleNodeIds: turn ? [turn.id] : [],
    visibleTurnIds: turn ? [turn.id] : [],
    nodes: turn ? [{
      nodeId: turn.id,
      parentNodeId: null,
      turnId: turn.id,
      order: 0,
      status: "completed",
      summary: turn.items.find((entry) => entry.type === "userMessage")?.content?.[0]?.text ?? null
    }] : []
  };
};

const send = (payload) => process.stdout.write(JSON.stringify(payload) + "\n");

const handle = (request) => {
  if (request.method === "initialized") return;
  if (request.method === "initialize") {
    send({ id: request.id, result: {
      userAgent: "vermillion-session-tree-fixture/1",
      codexHome: process.env.CODEX_HOME ?? null,
      platformFamily: process.platform,
      platformOs: process.platform
    } });
    return;
  }

  const params = request.params ?? {};
  switch (request.method) {
    case "thread/list": {
      const filtered = params.cwd ? threads.filter((item) => item.cwd === params.cwd) : threads;
      send({ id: request.id, result: { data: clone(filtered), nextCursor: null, backwardsCursor: null } });
      return;
    }
    case "thread/read": {
      const item = thread(String(params.threadId));
      if (!item) {
        send({ id: request.id, error: { code: -32004, message: `Thread not found: ${params.threadId}` } });
        return;
      }
      send({ id: request.id, result: { thread: threadForResponse(item, Boolean(params.includeTurns)) } });
      return;
    }
    case "thread/resume": {
      const item = thread(String(params.threadId));
      if (!item) {
        send({ id: request.id, error: { code: -32004, message: `Thread not found: ${params.threadId}` } });
        return;
      }
      send({ id: request.id, result: {
        thread: { ...threadForResponse(item, true), status: { type: "idle" } },
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
    }
    case "thread/turns/list": {
      const item = thread(String(params.threadId));
      send({ id: request.id, result: {
        data: item ? clone(item.turns) : [],
        nextCursor: null,
        backwardsCursor: null
      } });
      return;
    }
    case "thread/goal/get":
      send({ id: request.id, result: { goal: null } });
      return;
    case "thread/unsubscribe":
      send({ id: request.id, result: { status: "unsubscribed" } });
      return;
    case "chatTree/read": {
      const item = thread(String(params.threadId));
      send({ id: request.id, result: {
        threadId: String(params.threadId),
        chatTree: item ? chatTree(item) : { version: 1, revision: 1, currentNodeId: null, visibleNodeIds: [], visibleTurnIds: [], nodes: [] }
      } });
      return;
    }
    case "chatTree/setCurrent": {
      const item = thread(String(params.threadId));
      send({ id: request.id, result: { threadId: String(params.threadId), chatTree: item ? chatTree(item) : { version: 1, revision: 1, currentNodeId: null, visibleNodeIds: [], visibleTurnIds: [], nodes: [] } } });
      return;
    }
    case "getAuthStatus":
      send({ id: request.id, result: { authMethod: "apikey", authToken: null, requiresOpenaiAuth: false } });
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
