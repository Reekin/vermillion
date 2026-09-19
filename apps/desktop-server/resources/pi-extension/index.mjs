/**
 * Vermillion host extension for pi.
 *
 * Loaded with `pi --mode rpc ... -e <this file>`. It gives pi sessions the two things the
 * workbench relies on: the current role instructions on every turn, and the workbench host
 * tools. It also records turn markers so history reads rebuild the same entity ids as the
 * live event stream.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const turnEntryType = "vermillion.turn";
const messageEntryType = "vermillion.message";

const readText = (path) => {
  if (!path) return undefined;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

const readJson = (path) => {
  const text = readText(path);
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

export default function vermillionExtension(pi) {
  const sessionDir = process.env.VERMILLION_PI_SESSION_DIR;
  const sessionId = process.env.VERMILLION_SESSION_ID ?? "";
  const providerSessionId = process.env.VERMILLION_PI_SESSION_ID ?? "";
  const hostUrl = process.env.VERMILLION_PI_HOST_URL;
  const hostToken = process.env.VERMILLION_PI_HOST_TOKEN;
  const roleFile = sessionDir ? join(sessionDir, "role-instructions.md") : undefined;
  const pendingFile = sessionDir ? join(sessionDir, "pending-turn.json") : undefined;

  pi.on("before_agent_start", async (event) => {
    const pending = readJson(pendingFile) ?? {};
    pi.appendEntry(turnEntryType, {
      messageId: typeof pending.messageId === "string" ? pending.messageId : undefined,
      steer: pending.steer === true,
      startedAt: new Date().toISOString()
    });
    const role = readText(roleFile)?.trim();
    if (!role) {
      return undefined;
    }
    return { systemPrompt: `${event.systemPrompt}\n\n${role}` };
  });

  // A steering message is delivered inside the running turn, so it needs its own marker to keep
  // the workbench-assigned message id in the session history.
  pi.on("message_end", async (event) => {
    if (event.message?.role !== "user") {
      return;
    }
    const pending = readJson(pendingFile);
    if (!pending || pending.steer !== true || typeof pending.messageId !== "string") {
      return;
    }
    pi.appendEntry(messageEntryType, {
      messageId: pending.messageId,
      steer: true,
      at: new Date().toISOString()
    });
  });

  if (!hostUrl || !hostToken) {
    return;
  }

  const callHostTool = async (namespace, name, args) => {
    const response = await fetch(`${hostUrl}/host-tool`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: hostToken,
        sessionId,
        providerSessionId,
        namespace,
        name,
        arguments: args ?? {}
      })
    });
    const payload = await response.json();
    if (!payload?.ok) {
      throw new Error(payload?.error ?? "The workbench host tool call failed.");
    }
    return payload.result;
  };

  pi.registerTool({
    name: "vermillion_read_session",
    label: "Vermillion Read Session",
    description:
      "Read the visible user and agent messages of a Vermillion session by session id.",
    promptSnippet: "Read a Vermillion session transcript (vermillion.read_session)",
    promptGuidelines: [
      "Use vermillion_read_session when you need recent messages, timestamps and turn status of a Vermillion session."
    ],
    parameters: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description:
            "Vermillion session id, or the engine session id an engine tool reported for it, such as the id returned when spawning a subagent."
        },
        limit: {
          type: "number",
          description: "Return the most recent N messages, ordered oldest first."
        },
        maxChars: { type: "number", description: "Character budget for message bodies." }
      },
      required: ["sessionId"],
      additionalProperties: false
    },
    async execute(_toolCallId, params) {
      const result = await callHostTool("vermillion", "read_session", params);
      const content = Array.isArray(result?.contentItems)
        ? result.contentItems.map((item) =>
            item.type === "inputImage"
              ? { type: "image", data: item.imageUrl, mimeType: "image/png" }
              : { type: "text", text: item.text ?? "" }
          )
        : [{ type: "text", text: "" }];
      return { content, details: { success: result?.success !== false } };
    }
  });
}
