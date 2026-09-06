import { useCallback, useEffect, useState } from "react";
import type { WorkbenchStore } from "../workbench-store.js";
import { Modal } from "./Modal.js";
import { Button, InlineNotice } from "./ui.js";

/** Plain-text editor for document Markdown, including frontmatter. */
export const TextEditor = ({ store }: { store: WorkbenchStore }) => {
  const client = store((s) => s.client);
  const workspaceId = store((s) => s.browsingWorkspaceId);
  const target = store((s) => s.editor);
  const openEditor = store((s) => s.openEditor);
  const close = useCallback(() => openEditor(undefined), [openEditor]);
  const [content, setContent] = useState<string | undefined>();
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!workspaceId || target?.kind !== "doc") return;
    let cancelled = false;
    setContent(undefined);
    setDirty(false);
    setError(undefined);
    client.request("docs.read", { workspaceId, path: target.path })
      .then((r) => { if (!cancelled) setContent(r.content); })
      .catch(() => { if (!cancelled) setContent(""); });
    return () => { cancelled = true; };
  }, [client, workspaceId, target]);

  if (!workspaceId || target?.kind !== "doc") return null;

  const save = async () => {
    if (content === undefined) return;
    setSaving(true);
    setError(undefined);
    try {
      await client.request("docs.write", { workspaceId, path: target.path, content });
      setDirty(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={target.path.replace(/^\.vermillion\/docs\//, "")} onClose={close} width={860} height="78vh">
      <div
        className="flex h-full flex-col"
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === "s") { event.preventDefault(); void save(); }
        }}
      >
        {content === undefined ? (
          <div className="p-4 text-caption text-muted-foreground">加载中…</div>
        ) : (
          <textarea
            data-ui-raw="full-height editor"
            value={content}
            onChange={(event) => { setContent(event.target.value); setDirty(true); }}
            spellCheck={false}
            className="min-h-0 flex-1 resize-none bg-input p-4 text-label leading-relaxed text-foreground outline-none"
            style={{ fontFamily: "var(--awb-font-mono)" }}
          />
        )}
        {error && <InlineNotice tone="error">{error}</InlineNotice>}
        <footer className="flex h-10 items-center gap-3 border-t border-border px-4">
          <span className="text-caption text-faint-foreground">
            {dirty ? "未保存 · Ctrl+S" : "已保存"}
          </span>
          <Button size="sm" variant="primary" className="ml-auto" disabled={!dirty || saving} onClick={() => void save()}>{saving ? "保存中…" : "保存"}</Button>
        </footer>
      </div>
    </Modal>
  );
};
