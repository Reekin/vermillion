import { randomUUID } from "node:crypto";
import type { SessionShellService } from "@vermillion/desktop-server";
import type { CommandEnvelope, RuntimeCommandReceiptRpc } from "@vermillion/shared";
import type { WorkbenchService } from "@vermillion/workbench";

/** All desktop message entry points share the workbench's durable execution admission. */
export function connectExecutionDispatch(
  shell: Pick<SessionShellService, "setCommandDispatch" | "executeCommand" | "getActiveTurnId" | "ensureSessionLoadedForRead">,
  workbench: Pick<WorkbenchService, "dispatchSessionMessage" | "setMessageDeliveryPort">
): () => void {
  shell.setCommandDispatch(async (input, send) => {
    const command = input.command;
    if (command.type !== "sendUserMessage" && command.type !== "steerTurn") return send(input);
    let engineReceipt: RuntimeCommandReceiptRpc | undefined;
    const receipt = await workbench.dispatchSessionMessage({
      sessionId: command.sessionId,
      messageId: command.messageId,
      content: command.content,
      attachments: command.attachments,
      ...(command.type === "sendUserMessage" ? { execution: command.execution } : {})
    }, async (message) => {
      if (!await shell.ensureSessionLoadedForRead(message.sessionId)) {
        return { accepted: false, error: { code: "session_unavailable", message: "无法加载目标会话" } };
      }
      const activeTurnId = shell.getActiveTurnId(message.sessionId);
      if (!activeTurnId && message.allowStart === false) return {
        accepted: false,
        error: { code: "execution_readmission_required", message: "当前轮次已变化，需要重新检查执行条件" }
      };
      const envelope: CommandEnvelope = {
        commandId: input.commandId,
        command: activeTurnId
          ? { ...command, ...message, type: "steerTurn", turnId: activeTurnId, allowStart: message.allowStart !== false, attachments: message.attachments ?? [] }
          : { ...command, ...message, type: "sendUserMessage", attachments: message.attachments ?? [] }
      };
      const result = await send(envelope);
      engineReceipt = result;
      return {
        accepted: result.accepted,
        queued: result.queued,
        error: result.error,
        turnId: result.turnId,
        delivery: result.delivery === "steered" ? "steered" : "started"
      };
    });
    return {
      ...engineReceipt,
      commandId: input.commandId,
      commandType: command.type,
      sessionId: command.sessionId,
      accepted: receipt.accepted,
      queued: receipt.queued,
      error: receipt.error,
      turnId: receipt.turnId,
      ...(receipt.delivery === "steered" ? { delivery: "steered" as const } : {})
    };
  });
  return workbench.setMessageDeliveryPort(async (message) => {
    const result = await shell.executeCommand({
      commandId: randomUUID(),
      command: {
        type: "sendUserMessage", sessionId: message.sessionId, messageId: message.messageId,
        content: message.content, attachments: message.attachments ?? [], execution: message.execution
      }
    });
    return {
      accepted: result.accepted, queued: result.queued, error: result.error, turnId: result.turnId,
      delivery: result.delivery === "steered" ? "steered" : "started"
    };
  });
}
