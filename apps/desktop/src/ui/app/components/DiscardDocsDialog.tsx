import { useEffect, useState } from "react";
import type { DocChange, WorkbenchClient } from "@vermillion/workbench/client";
import { Modal } from "./Modal.js";
import { Button, InlineNotice } from "./ui.js";

const actionLabel = { added: "删除新增文件", modified: "还原修改", deleted: "恢复已删除文件" };

export const DiscardDocsDialog = ({ client, workspaceId, path, onClose }: {
  client: WorkbenchClient; workspaceId: string; path: string; onClose: () => void;
}) => {
  const [changes, setChanges] = useState<DocChange[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void client.request("docs.discardPreview", { workspaceId, paths: [path] }).then(
      (result) => { if (active) setChanges(result); },
      (caught: Error) => { if (active) setError(caught.message); }
    );
    return () => { active = false; };
  }, [client, workspaceId, path]);
  const discard = async () => {
    if (!changes?.length) return;
    setBusy(true);
    setError(undefined);
    try {
      await client.request("docs.discard", { workspaceId, paths: changes.map((change) => change.path) });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally { setBusy(false); }
  };
  const close = () => { if (!busy) onClose(); };
  return <Modal title="丢弃文档变更" onClose={close} width={560}>
    <div className="p-4">
      <p className="text-body text-foreground">以下文件将恢复到最近一次提交的状态。未提交的修改会丢失。</p>
      {changes ? changes.length ? <ul className="mt-3 max-h-60 overflow-auto rounded-md border border-border">
        {changes.map((change) => <li key={change.path} className="flex items-start gap-3 border-b border-border px-3 py-2 last:border-b-0">
          <span className="min-w-0 flex-1 break-all font-mono text-caption text-foreground">{change.path.replace(/^\.vermillion\/docs\//, "")}</span>
          <span className="shrink-0 text-caption text-muted-foreground">{actionLabel[change.status]}</span>
        </li>)}
      </ul> : <InlineNotice className="mt-3 px-0">所选范围没有未提交的变更。</InlineNotice>
        : !error && <InlineNotice className="mt-3 px-0">正在读取变更…</InlineNotice>}
      {error && <InlineNotice tone="error" className="mt-3 px-0">{error}</InlineNotice>}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={close} disabled={busy}>取消</Button>
        <Button onClick={() => void discard()} disabled={busy || !changes?.length}>{busy ? "正在丢弃…" : "丢弃变更"}</Button>
      </div>
    </div>
  </Modal>;
};
