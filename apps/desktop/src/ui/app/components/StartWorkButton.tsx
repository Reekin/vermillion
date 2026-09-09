import { useState } from "react";
import { Button, InlineNotice } from "./ui.js";
import type { ComposerActions } from "../../chat-shell/composer/composer-types.js";
import type { WorkRequest } from "@vermillion/workbench/client";

export const StartWorkButton = ({ sessionId, turnId, composer, onStart }: {
  sessionId?: string; turnId?: string;
  composer?: ComposerActions;
  onStart: (input: { sessionId: string; turnId?: string; message?: WorkRequest["message"] }) => Promise<void>;
}) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const start = async () => {
    if (composer?.hasContent ? !composer.canSubmit : !sessionId || !turnId) return;
    setBusy(true);
    setError(undefined);
    try {
      if (composer?.hasContent) await composer.submitUsing(async ({ sessionId: resolvedSessionId, ...message }) => {
        await onStart({ sessionId: resolvedSessionId, turnId, message });
      });
      else await onStart({ sessionId: sessionId!, turnId: turnId! });
    }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };
  return <><Button variant="primary" className="w-full" disabled={busy || (composer?.hasContent ? !composer.canSubmit : !sessionId || !turnId)} onClick={() => void start()}>{busy ? "开工中…" : composer?.hasContent ? "发送并开工" : "开工"}</Button>
    {error && <InlineNotice tone="error">{error}</InlineNotice>}</>;
};
