import { useMemo, useState } from "react";
import type { DocChange } from "@vermillion/workbench/client";
import { cn } from "../lib/cn.js";
import { Modal } from "./Modal.js";
import { Button, Field, InlineNotice } from "./ui.js";

type CommitDocsDialogProps = {
  pending: DocChange[];
  onClose: () => void;
  onCommit: (input: { message: string; paths: string[] }) => Promise<void>;
};

const stripDocsPrefix = (path: string): string => path.replace(/^\.vermillion\/docs\//, "");

const statusMark: Record<DocChange["status"], string> = { added: "U", modified: "M", deleted: "D" };

export const CommitDocsDialog = ({ pending, onClose, onCommit }: CommitDocsDialogProps) => {
  const changeByPath = useMemo(() => new Map(pending.map((c) => [c.path, c])), [pending]);
  const listed = useMemo(() => pending.map((c) => c.path).sort(), [pending]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(pending.map((c) => c.path)));
  const selectedPaths = useMemo(() => listed.filter((p) => selected.has(p)), [listed, selected]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const togglePath = (path: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const canSubmit = selectedPaths.length > 0 && message.trim().length > 0;
  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await onCommit({ message: message.trim(), paths: selectedPaths });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="仅提交文档" onClose={onClose} width={560}>
      <form
        className="p-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit && !busy) void submit();
        }}
      >
        <Field label="提交说明" autoFocus value={message} onChange={(event) => setMessage(event.target.value)} placeholder="这次改了什么" />

        <div className="mt-4">
          <div className="flex items-center justify-between gap-2">
            <span className="eyebrow">本次提交的文件 {selectedPaths.length}/{listed.length}</span>
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set(listed))}>全选</Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected((current) => new Set(listed.filter((path) => !current.has(path))))}>反选</Button>
            </div>
          </div>
          <ul className="mt-1.5 max-h-44 overflow-auto rounded-lg border border-border">
            {listed.map((path) => {
              const change = changeByPath.get(path);
              return (
                <li key={path}>
                  <label className="flex h-7 cursor-pointer items-center gap-2 px-2.5 text-label hover:bg-surface-hover">
                    <input type="checkbox" checked={selected.has(path)} onChange={() => togglePath(path)} className="accent-[var(--awb-accent-strong)]" />
                    <span className="w-3 font-mono text-micro text-accent-strong">{change ? statusMark[change.status] : ""}</span>
                    <span className={cn("truncate", change ? "text-strong" : "text-foreground")}>{stripDocsPrefix(path)}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>

        {error && <InlineNotice tone="error" className="mt-3 px-0 pb-0">{error}</InlineNotice>}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" type="submit" disabled={busy || !canSubmit}>
            {busy ? "提交中…" : "提交"}
          </Button>
        </div>
      </form>
    </Modal>
  );
};
