import { appendAttachmentMarkdown, type ChatTreeSendOperation } from "@vermillion/shared";
import { Button } from "./Button.js";
import { useT } from "../../i18n/react.js";
import {
  MessageMarkdownView,
  type RenderMessageFileLinkMenu
} from "./MessageMarkdownView.js";

export const PendingBranchMessage = ({ operation, onRetry, onPreviewImage, renderFileLinkContextMenu }: {
  operation: ChatTreeSendOperation;
  onRetry: (operationId: string) => Promise<void>;
  onPreviewImage?: (input: { src: string; alt: string }) => void;
  renderFileLinkContextMenu?: RenderMessageFileLinkMenu;
}) => {
  const t = useT();
  return <article className="awb-chat-entry is-user" aria-label={t("session.pendingMessage")}>
    <MessageMarkdownView block={{
      blockId: operation.operationId,
      messageId: operation.operationId,
      sessionId: operation.sessionId,
      turnId: operation.operationId,
      role: "user",
      kind: "plain_text",
      text: appendAttachmentMarkdown(operation.content, operation.attachments),
      startedAt: ""
    }} onPreviewImage={onPreviewImage} renderFileLinkContextMenu={renderFileLinkContextMenu} />
    {operation.status === "failed" && <>
      <p role="alert" className="awb-pending-message-error">{operation.error}</p>
      {!operation.cleanupPending && <Button onClick={() => void onRetry(operation.operationId)}>{t("session.retrySend")}</Button>}
    </>}
  </article>;
};
