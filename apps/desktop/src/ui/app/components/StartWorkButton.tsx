import { useState } from "react";
import { Button, InlineNotice } from "./ui.js";
import type { ComposerActions } from "../../chat-shell/composer/composer-types.js";

export const StartWorkButton = ({ sessionId, turnId, composer, onStart }: {
  sessionId?: string; turnId?: string;
  composer?: ComposerActions;
  onStart: (input: { sessionId: string; turnId: string }) => Promise<void>;
}) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const start = async () => {
    if (composer?.hasContent ? !composer.canSubmit : !sessionId || !turnId) return;
    setBusy(true);
    setError(undefined);
    try {
      if (composer?.hasContent) await composer.submitWithInstruction("以上需求已确认，请发单开工。通过 vermillion work.start 登记本条需求，范围包含本条消息；本轮只登记开工并简短回复，由 Worker 整理文档、建单和执行。");
      else await onStart({ sessionId: sessionId!, turnId: turnId! });
    }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };
  return <><Button variant="primary" className="w-full" disabled={busy || (composer?.hasContent ? !composer.canSubmit : !sessionId || !turnId)} onClick={() => void start()}>{busy ? "开工中…" : composer?.hasContent ? "发送并开工" : "开工"}</Button>
    {error && <InlineNotice tone="error">{error}</InlineNotice>}</>;
};
