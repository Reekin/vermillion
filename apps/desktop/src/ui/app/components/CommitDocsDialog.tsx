import { useMemo, useState } from "react";
import type { DocChange, Mission } from "@vermillion/workbench/client";
import { cn } from "../lib/cn.js";
import { Modal } from "./Modal.js";
import { Button, Field, InlineNotice } from "./ui.js";

type CommitDocsDialogProps = {
  pending: DocChange[];
  /** Active missions the changes may be appended to. */
  missions: Mission[];
  /** Mission created from the current session, preselected when present. */
  defaultMissionId?: string;
  onClose: () => void;
  onCreate: (input: { title: string; summary: string; paths: string[] }) => Promise<void>;
  onAppend: (input: { missionId: string; message: string; paths: string[] }) => Promise<void>;
  onCommit: (input: { message: string; paths: string[] }) => Promise<void>;
};

const stripDocsPrefix = (path: string): string => path.replace(/^\.vermillion\/docs\//, "");

/** Default title from what is being committed: the single file's name, or the deepest shared folder. */
const inferTitle = (paths: string[]): string => {
  if (paths.length === 0) return "";
  const names = paths.map(stripDocsPrefix);
  if (names.length === 1) return names[0]!.replace(/\.md$/, "").split("/").pop() ?? "";
  const segments = names.map((n) => n.split("/").slice(0, -1));
  const shared: string[] = [];
  for (let i = 0; ; i += 1) {
    const seg = segments[0]?.[i];
    if (seg === undefined || segments.some((s) => s[i] !== seg)) break;
    shared.push(seg);
  }
  // A top-level bucket like "specs" says nothing about the change; prefer the first file's name then.
  return shared.length > 1 ? shared.at(-1)! : names[0]!.replace(/\.md$/, "").split("/").pop() ?? "";
};

const statusMark: Record<DocChange["status"], string> = { added: "U", modified: "M", deleted: "D" };

export const CommitDocsDialog = ({ pending, missions, defaultMissionId, onClose, onCreate, onAppend, onCommit }: CommitDocsDialogProps) => {
  const active = missions.filter((m) => m.status === "active");
  const [mode, setMode] = useState<"create" | "append" | "commit">(defaultMissionId && active.some((m) => m.missionId === defaultMissionId) ? "append" : "create");
  const [missionId, setMissionId] = useState(defaultMissionId ?? active[0]?.missionId ?? "");
  const [selected, setSelected] = useState<Set<string>>(() => new Set(pending.map((c) => c.path)));
  const selectedPaths = useMemo(() => pending.map((c) => c.path).filter((p) => selected.has(p)), [pending, selected]);
  const [title, setTitle] = useState(() => inferTitle(pending.map((c) => c.path)));
  const [summary, setSummary] = useState("");
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

  const canSubmit = selectedPaths.length > 0 && (mode === "create" ? title.trim().length > 0 : mode === "append" ? missionId.length > 0 : message.trim().length > 0);
  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      if (mode === "create") await onCreate({ title: title.trim(), summary: summary.trim(), paths: selectedPaths });
      else if (mode === "append") await onAppend({ missionId, message: message.trim(), paths: selectedPaths });
      else await onCommit({ message: message.trim(), paths: selectedPaths });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="提交 Doc 变更" onClose={onClose} width={560}>
      <form
        className="p-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit && !busy) void submit();
        }}
      >
        <div className="flex gap-1 rounded-lg border border-border p-0.5" role="radiogroup" aria-label="提交方式">
          {[
            { id: "create" as const, label: "新任务" },
            { id: "append" as const, label: "补充到现有任务", disabled: active.length === 0 },
            { id: "commit" as const, label: "仅提交" }
          ].map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={mode === option.id}
              disabled={option.disabled}
              onClick={() => setMode(option.id)}
              className={cn(
                "flex-1 rounded-md py-1.5 text-label text-muted-foreground disabled:opacity-40",
                mode === option.id && "bg-surface-selected text-strong"
              )}
            >
              {option.label}
            </button>
          ))}
        </div>

        {mode === "create" ? (
          <>
            <Field label="标题" autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="这次要做什么" className="mt-4" />
            <Field kind="textarea" label="摘要" value={summary} onChange={(event) => setSummary(event.target.value)} rows={3} placeholder="预期效果" className="mt-3" />
          </>
        ) : (
          <>
            {mode === "append" && (
            <Field kind="select" label="任务" value={missionId} onChange={(event) => setMissionId(event.target.value)} className="mt-4">
              {active.map((m) => (
                <option key={m.missionId} value={m.missionId}>{m.title}</option>
              ))}
            </Field>
            )}
            <Field label={mode === "commit" ? "提交说明" : "变更说明"} autoFocus value={message} onChange={(event) => setMessage(event.target.value)} placeholder="这次改了什么" className="mt-3" />
          </>
        )}

        <div className="mt-4">
          <div className="flex items-center justify-between gap-2">
            <span className="eyebrow">本次提交的文件 {selectedPaths.length}/{pending.length}</span>
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set(pending.map((change) => change.path)))}>全选</Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected((current) => new Set(pending.map((change) => change.path).filter((path) => !current.has(path))))}>反选</Button>
            </div>
          </div>
          <ul className="mt-1.5 max-h-44 overflow-auto rounded-lg border border-border">
            {pending.map((change) => (
              <li key={change.path}>
                <label className="flex h-7 cursor-pointer items-center gap-2 px-2.5 text-label hover:bg-surface-hover">
                  <input type="checkbox" checked={selected.has(change.path)} onChange={() => togglePath(change.path)} className="accent-[var(--awb-accent-strong)]" />
                  <span className="w-3 font-mono text-micro text-accent-strong">{statusMark[change.status]}</span>
                  <span className="truncate text-foreground">{stripDocsPrefix(change.path)}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>

        {error && <InlineNotice tone="error" className="mt-3 px-0 pb-0">{error}</InlineNotice>}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" type="submit" disabled={busy || !canSubmit}>
            {busy ? "提交中…" : mode === "create" ? "创建任务" : mode === "append" ? "补充任务" : "提交"}
          </Button>
        </div>
      </form>
    </Modal>
  );
};
