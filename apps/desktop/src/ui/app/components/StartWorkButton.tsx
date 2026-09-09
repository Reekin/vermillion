import { useState } from "react";
import { Button, InlineNotice } from "./ui.js";

export const StartWorkButton = ({ sessionId, turnId, onStart }: {
  sessionId?: string; turnId?: string;
  onStart: (input: { sessionId: string; turnId: string }) => Promise<void>;
}) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const start = async () => {
    if (!sessionId || !turnId) return;
    setBusy(true);
    setError(undefined);
    try { await onStart({ sessionId, turnId }); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };
  return <><Button variant="primary" className="w-full" disabled={!sessionId || !turnId || busy} onClick={() => void start()}>{busy ? "开工中…" : "开工"}</Button>
    {error && <InlineNotice tone="error">{error}</InlineNotice>}</>;
};
