import type { WorkbenchClient } from "@vermillion/workbench/client";
import type { DesktopTransport } from "../../transport/desktop-transport.js";
import type { ComposerActions } from "../chat-shell/composer/composer-types.js";

/** Capture the selected work and historical position before any asynchronous transfer. */
export const continueWorkFrom = async ({ client, transport, composer, workspaceId, target, sessionId, turnId, open }: {
  client: WorkbenchClient;
  transport: DesktopTransport;
  composer?: ComposerActions;
  workspaceId: string;
  target: { workItemId: string } | { requestId: string };
  sessionId: string;
  turnId: string;
  open: (workspaceId: string, sessionId: string) => Promise<void>;
}) => {
  const transfer = async () => {
    const source = { workspaceId, sessionId, turnId };
    const targetSessionId = "workItemId" in target
      ? (await client.request("workItem.continueFrom", { ...source, workItemId: target.workItemId })).run.sessionId
      : (await client.request("work.continueFrom", { ...source, requestId: target.requestId })).workerSessionId;
    if (!targetSessionId) throw new Error("执行分支尚未就绪。");
    await open(workspaceId, targetSessionId);
    return targetSessionId;
  };
  if (!composer?.hasContent) { await transfer(); return; }
  await composer.submitUsing(async (payload) => {
    const targetSessionId = await transfer();
    const receipt = await transport.chat.send({ ...payload, sessionId: targetSessionId });
    if (!receipt.accepted && !receipt.queued) throw new Error("发送未被受理，消息仍保留在输入器中。");
  });
};
