import { appendAttachmentMarkdown, type ChatTreeSendOperation } from "@vermillion/shared";
import { Button } from "./Button.js";
import { MessageMarkdownView } from "./MessageMarkdownView.js";

export const PendingBranchMessage = ({ operation, onRetry, onPreviewImage }: {
  operation: ChatTreeSendOperation;
  onRetry: (operationId: string) => Promise<void>;
  onPreviewImage?: (input: { src: string; alt: string }) => void;
}) => (
  <article className="awb-chat-entry is-user" aria-label="待发送消息">
    <MessageMarkdownView block={{
      blockId: operation.operationId,
      messageId: operation.operationId,
      sessionId: operation.sessionId,
      turnId: operation.operationId,
      role: "user",
      kind: "plain_text",
      text: appendAttachmentMarkdown(operation.content, operation.attachments),
      startedAt: ""
    }} onPreviewImage={onPreviewImage} />
    {operation.status === "failed" && <>
      <p role="alert" className="awb-pending-message-error">{operation.error}</p>
      <Button onClick={() => void onRetry(operation.operationId)}>重试发送</Button>
    </>}
  </article>
);
