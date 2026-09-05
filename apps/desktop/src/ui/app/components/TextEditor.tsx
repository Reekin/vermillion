import { useCallback, useEffect, useState } from "react";
import type { EditorTarget, WorkbenchStore } from "../workbench-store.js";
import { Modal } from "./Modal.js";
import { Button } from "./ui.js";

const titleOf = (target: EditorTarget): string =>
  target.kind === "doc" ? target.path.replace(/^\.vermillion\/docs\//, "") : "角色 · " + target.roleId;

/** Plain-text editor modal for a doc or a role prompt override; saves straight to disk. */
export const TextEditor = ({ store }: { store: WorkbenchStore }) => {
  const client = store((s) => s.client);
  const workspaceId = store((s) => s.browsingWorkspaceId);
  const target = store((s) => s.editor);
  const openEditor = store((s) => s.openEditor);
  const close = useCallback(() => openEditor(undefined), [openEditor]);
  const [content, setContent] = useState<string | undefined>();
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!workspaceId || !target) return;
    let cancelled = false;
    setContent(undefined);
    setDirty(false);
    const read =
      target.kind === "doc"
        ? client.request("docs.read", { workspaceId, path: target.path })
        : client.request("role.read", { workspaceId, roleId: target.roleId });
    read
      .then((r) => { if (!cancelled) setContent(r.content); })
      .catch(() => { if (!cancelled) setContent(""); });
    return () => { cancelled = true; };
  }, [client, workspaceId, target]);

  if (!workspaceId || !target) return null;

  const save = async () => {
    if (content === undefined) return;
    setSaving(true);
    try {
      if (target.kind === "doc") await client.request("docs.write", { workspaceId, path: target.path, content });
      else await client.request("role.write", { workspaceId, roleId: target.roleId, content });
      setDirty(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={titleOf(target)} onClose={close} width={860} height="78vh">
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
            value={content}
            onChange={(event) => { setContent(event.target.value); setDirty(true); }}
            spellCheck={false}
            className="min-h-0 flex-1 resize-none bg-input p-4 text-label leading-relaxed text-foreground outline-none"
            style={{ fontFamily: "var(--awb-font-mono)" }}
          />
        )}
        <footer className="flex h-10 items-center gap-3 border-t border-border px-4">
          <span className="text-caption text-faint-foreground">
            {target.kind === "role" ? "保存后成为本 workspace 的覆盖版本 · " : ""}
            {dirty ? "未保存 · Ctrl+S" : "已保存"}
          </span>
          <Button size="sm" variant="primary" className="ml-auto" disabled={!dirty || saving} onClick={() => void save()}>{saving ? "保存中…" : "保存"}</Button>
        </footer>
      </div>
    </Modal>
  );
};
