import { X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { WorkbenchStore } from "../workbench-store.js";
import { Button } from "./ui.js";

/** Plain-text editor for one doc; saves to disk, commit happens in the mission flow. */
export const DocEditor = ({ store }: { store: WorkbenchStore }) => {
  const client = store((s) => s.client);
  const workspaceId = store((s) => s.activeWorkspaceId);
  const path = store((s) => s.openDocPath);
  const setOpenDocPath = store((s) => s.setOpenDocPath);
  const close = useCallback(() => setOpenDocPath(undefined), [setOpenDocPath]);
  const refreshWorkspaceData = store((s) => s.refreshWorkspaceData);
  const [content, setContent] = useState<string | undefined>();
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!workspaceId || !path) return;
    let cancelled = false;
    setContent(undefined);
    setDirty(false);
    client
      .request("docs.read", { workspaceId, path })
      .then((r) => { if (!cancelled) setContent(r.content); })
      .catch(() => { if (!cancelled) setContent(""); });
    return () => { cancelled = true; };
  }, [client, workspaceId, path]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  if (!workspaceId || !path) return null;

  const save = async () => {
    if (content === undefined) return;
    setSaving(true);
    try {
      await client.request("docs.write", { workspaceId, path, content });
      setDirty(false);
      await refreshWorkspaceData();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/55 pt-[8vh]" onMouseDown={close} role="presentation">
      <div
        role="dialog"
        aria-label={path}
        className="flex h-[80vh] w-[860px] max-w-[94vw] flex-col overflow-hidden rounded-xl border border-surface-border bg-surface-raised surface-shadow"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === "s") { event.preventDefault(); void save(); }
        }}
      >
        <header className="flex items-center gap-3 border-b border-border px-4 py-2.5">
          <h2 className="truncate font-mono text-label">{path}</h2>
          {dirty && <span className="text-micro text-warning">未保存</span>}
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="primary" disabled={!dirty || saving} onClick={() => void save()}>{saving ? "保存中…" : "保存"}</Button>
            <button type="button" className="rounded-md p-1.5 text-muted-foreground hover:bg-surface-hover hover:text-foreground" aria-label="关闭" onClick={close}><X size={16} /></button>
          </div>
        </header>
        {content === undefined ? (
          <div className="p-4 text-caption text-muted-foreground">加载中…</div>
        ) : (
          <textarea
            value={content}
            onChange={(event) => { setContent(event.target.value); setDirty(true); }}
            spellCheck={false}
            className="min-h-0 flex-1 resize-none bg-surface p-4 font-mono text-label leading-relaxed text-foreground outline-none"
          />
        )}
      </div>
    </div>
  );
};
