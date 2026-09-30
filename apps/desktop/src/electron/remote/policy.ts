import { safeParseSessionRpcRequest } from "@vermillion/shared";

const sessionReads = new Set([
  "sessionBrowser.list", "sessionBrowser.changes", "sessionBrowser.open", "session.list",
  "chatTree.get", "chatTree.readProgress", "chatTree.cancelRead", "chatTree.markRead",
  "events.subscribe", "events.replay", "events.unsubscribe", "workspace.list",
  "engine.list", "engine.getSurface", "chat.getCapabilities"
]);
const workbenchMethods = new Set(["workspace.list", "workItem.get", "workItem.list", "work.list", "inbox.list", "decision.answer", "inbox.acknowledge"]);

export function allowRemoteRequest(channel: string, raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const request = raw as { method?: string };
  if (channel === "workbench") return typeof request.method === "string" && workbenchMethods.has(request.method);
  if (channel !== "session") return false;
  const parsed = safeParseSessionRpcRequest(raw);
  if (!parsed.success) return false;
  if (sessionReads.has(parsed.data.method)) return true;
  if (parsed.data.method !== "runtime.command") return false;
  const command = parsed.data.params.envelope.command;
  if (!["sendUserMessage", "steerTurn", "interruptTurn", "respondApproval", "respondInteraction"].includes(command.type)) return false;
  if ("cwd" in command && command.cwd !== undefined) return false;
  if (("developerInstructions" in command && command.developerInstructions !== undefined) ||
      ("deliveredDeveloperInstructions" in command && command.deliveredDeveloperInstructions !== undefined)) return false;
  if ("execution" in command && command.execution !== undefined) return false;
  if ("attachments" in command && command.attachments.length > 0) return false;
  return true;
}
