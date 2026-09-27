import { useEffect, useState } from "react";
import type { DocChange, WorkbenchClient } from "@vermillion/workbench/client";
import { Modal } from "./Modal.js";
import { Button, InlineNotice } from "./ui.js";
import { useT } from "../../../i18n/react.js";

export const DiscardDocsDialog = ({ client, workspaceId, path, sessionId, onClose }: {
  client: WorkbenchClient; workspaceId: string; path: string; sessionId?: string; onClose: () => void;
}) => {
  const t = useT();
  const actionLabel: Record<DocChange["status"], string> = { added: t("docs.discard.added"), modified: t("docs.discard.modified"), deleted: t("docs.discard.deleted") };
  const [changes, setChanges] = useState<DocChange[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void client.request("docs.discardPreview", { workspaceId, paths: [path], sessionId }).then(
      (result) => { if (active) setChanges(result); },
      (caught: Error) => { if (active) setError(caught.message); }
    );
    return () => { active = false; };
  }, [client, workspaceId, path, sessionId]);
  const discard = async () => {
    if (!changes?.length) return;
    setBusy(true);
    setError(undefined);
    try {
      await client.request("docs.discard", { workspaceId, paths: changes.map((change) => change.path), sessionId });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally { setBusy(false); }
  };
  const close = () => { if (!busy) onClose(); };
  return <Modal title={t("docs.discard.title")} onClose={close} width={560}>
    <div className="p-4">
      <p className="text-body text-foreground">{t("docs.discard.body")}</p>
      {changes ? changes.length ? <ul className="mt-3 max-h-60 overflow-auto rounded-md border border-border">
        {changes.map((change) => <li key={change.path} className="flex items-start gap-3 border-b border-border px-3 py-2 last:border-b-0">
          <span className="min-w-0 flex-1 break-all font-mono text-caption text-foreground">{change.path.replace(/^\.vermillion\/docs\//, "")}</span>
          <span className="shrink-0 text-caption text-muted-foreground">{actionLabel[change.status]}</span>
        </li>)}
      </ul> : <InlineNotice className="mt-3 px-0">{t("docs.discard.none")}</InlineNotice>
        : !error && <InlineNotice className="mt-3 px-0">{t("docs.discard.loading")}</InlineNotice>}
      {error && <InlineNotice tone="error" className="mt-3 px-0">{error}</InlineNotice>}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={close} disabled={busy}>{t("common.cancel")}</Button>
        <Button onClick={() => void discard()} disabled={busy || !changes?.length}>{busy ? t("docs.discard.busy") : t("docs.discard.submit")}</Button>
      </div>
    </div>
  </Modal>;
};
