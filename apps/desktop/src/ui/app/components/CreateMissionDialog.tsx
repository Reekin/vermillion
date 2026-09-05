import { useState } from "react";
import { Modal } from "./Modal.js";
import { Button } from "./ui.js";

export const CreateMissionDialog = ({
  onClose,
  onSubmit
}: {
  onClose: () => void;
  onSubmit: (input: { title: string; summary: string }) => Promise<void>;
}) => {
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="创建任务" onClose={onClose} width={520}>
      <form
        className="p-4"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!title.trim()) return;
          setBusy(true);
          try {
            await onSubmit({ title: title.trim(), summary: summary.trim() });
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="text-caption text-muted-foreground">docs 的待确认变更会作为这个任务的依据被提交。</p>
        <label className="mt-4 block">
          <span className="eyebrow">标题</span>
          <input
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className="mt-1.5 h-8 w-full rounded-lg border border-control-border bg-input px-3 text-body text-foreground outline-none focus:border-control-border-hover"
            placeholder="例如：导出页增加日期范围筛选"
          />
        </label>
        <label className="mt-3 block">
          <span className="eyebrow">摘要</span>
          <textarea
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
            rows={4}
            className="mt-1.5 w-full resize-none rounded-lg border border-control-border bg-input px-3 py-2 text-body text-foreground outline-none focus:border-control-border-hover"
            placeholder="这次任务要达到什么效果"
          />
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" type="submit" disabled={busy || !title.trim()}>{busy ? "创建中…" : "创建任务"}</Button>
        </div>
      </form>
    </Modal>
  );
};
