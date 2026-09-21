import { deflateSync } from "node:zlib";

export const memberCount = 13;
export const totalTurns = 108;
export const providerId = (member) => `history-reuse-${member}`;
export const sessionId = (member) => `codex-thread:${providerId(member)}`;
export const turnCount = (member) => member < 4 ? 9 : 8;
export const turnId = (member, turn) => `${providerId(member)}-turn-${turn}`;
const epoch = Date.parse("2026-09-01T00:00:00Z");
const timestamp = (member, turn = 0) => epoch + member * 60_000 + turn * 2_000;

// Deterministic, decodable RGB PNG: 108 inline images produce about 30 MiB JSON.
function image() {
  const size = 270;
  const pixels = Buffer.alloc((size * 3 + 1) * size);
  let random = 17;
  for (let y = 0; y < size; y++) {
    for (let x = 1; x <= size * 3; x++) {
      random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
      pixels[y * (size * 3 + 1) + x] = random & 255;
    }
  }
  const chunk = (type, bytes) => {
    const name = Buffer.from(type);
    let crc = 0xffffffff;
    for (const byte of Buffer.concat([name, bytes])) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, name, bytes, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
  return `data:image/png;base64,${Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))
  ]).toString("base64")}`;
}
export const imageUrl = image();

export function makeSnapshot(member, workspaceId, projectPath, generation = 0) {
  const id = sessionId(member);
  const conversationId = "history-reuse-conversation";
  const createdAt = new Date(timestamp(member)).toISOString();
  const turns = Array.from({ length: turnCount(member) }, (_, turn) => ({
    turnId: turnId(member, turn), sessionId: id, status: "completed", finishReason: "completed",
    startedAt: new Date(timestamp(member, turn)).toISOString(),
    completedAt: new Date(timestamp(member, turn) + 1000).toISOString(),
    messageIds: [`${turnId(member, turn)}-user`, `${turnId(member, turn)}-agent`],
    toolCallIds: [], terminalIds: [], approvalRequestIds: [], interactionRequestIds: []
  }));
  return {
    workspaceId,
    conversation: { conversationId, workspaceId, participantEngineIds: ["codex"],
      sessionIds: [id], createdAt, updatedAt: createdAt },
    session: { sessionId: id, conversationId, engineId: "codex", status: "idle",
      title: `History reuse ${member + 1}/13`, createdAt, updatedAt: createdAt,
      lastTurnId: turns.at(-1).turnId, metadata: { cwd: projectPath } },
    turns,
    messageBlocks: turns.flatMap((turn, index) => [
      { blockId: `${turn.turnId}-user-block`, messageId: turn.messageIds[0], sessionId: id,
        turnId: turn.turnId, role: "user", kind: "markdown", startedAt: turn.startedAt,
        completedAt: turn.completedAt, text: `Question ${member}:${index}\n\n![Synthetic image](${imageUrl})` },
      { blockId: `${turn.turnId}-agent-block`, messageId: turn.messageIds[1], sessionId: id,
        turnId: turn.turnId, role: "assistant", kind: "markdown", startedAt: turn.startedAt,
        completedAt: turn.completedAt, text: `Answer ${member}:${index}, generation ${generation}` }
    ]),
    toolCalls: [], terminalStreams: [], sessionRelations: [],
    runtimeBinding: { providerKind: "codex-thread", providerSessionId: providerId(member) }
  };
}

export function makeThreads(projectPath) {
  return Array.from({ length: memberCount }, (_, member) => {
    const snapshot = makeSnapshot(member, "fixture", projectPath);
    return {
      id: providerId(member), sessionId: providerId(member),
      forkedFromId: member ? providerId(member - 1) : null,
      parentThreadId: null, preview: `Question ${member}:0`, name: snapshot.session.title,
      ephemeral: false, path: null, cwd: projectPath, source: "appServer", threadSource: null,
      modelProvider: "fixture", model: "gpt-5.6-luna", reasoningEffort: "max",
      createdAt: timestamp(member) / 1000, updatedAt: timestamp(member, turnCount(member)) / 1000,
      status: { type: "idle" }, cliVersion: "fixture", gitInfo: null,
      agentNickname: null, agentRole: null, historyMode: "paginated",
      turns: snapshot.turns.map((turn, index) => ({
        id: turn.turnId, status: "completed", error: null, itemsView: "full",
        startedAt: timestamp(member, index) / 1000,
        completedAt: timestamp(member, index) / 1000 + 1, durationMs: 1000,
        items: [
          { type: "userMessage", id: turn.messageIds[0], content: [
            { type: "text", text: `Question ${member}:${index}`, text_elements: [] },
            { type: "image", url: imageUrl }
          ] },
          { type: "agentMessage", id: turn.messageIds[1], text: `Answer ${member}:${index}`,
            phase: "final_answer", memoryCitation: null }
        ]
      }))
    };
  });
}
