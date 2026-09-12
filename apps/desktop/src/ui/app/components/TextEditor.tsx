import { useCallback, useEffect, useState } from "react";
import type { EditorTarget, WorkbenchStore } from "../workbench-store.js";
import { Modal } from "./Modal.js";
import { Button, InlineNotice, MarkdownPreview, PanelHeader, SourceEditor } from "./ui.js";

export const TextEditor = ({ store }: { store: WorkbenchStore }) => {
  const workspaceId = store((s) => s.browsingWorkspaceId);
  const target = store((s) => s.editor);
  return workspaceId && (target?.kind === "doc" || target?.kind === "maintainer")
    ? <DocumentEditor key={workspaceId + ":" + target.path + ":" + (target.kind === "doc" ? target.line + ":" + target.column : "") + ":" + target.nonce} store={store} workspaceId={workspaceId} target={target} />
    : null;
};

const DocumentEditor = ({ store, workspaceId, target }: { store: WorkbenchStore; workspaceId: string; target: Extract<EditorTarget, { kind: "doc" | "maintainer" }> }) => {
  const path = target.path;
  const line = target.kind === "doc" ? target.line : undefined;
  const column = target.kind === "doc" ? target.column : undefined;
  const client = store((s) => s.client);
  const rootPath = store((s) => s.workspaces.find((w) => w.workspaceId === workspaceId)?.rootPath ?? "");
  const openEditor = store((s) => s.openEditor);
  const close = useCallback(() => openEditor(undefined), [openEditor]);
  const [content, setContent] = useState<string>();
  const [saved, setSaved] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const dirty = content !== saved;
  const markdown = /\.(md|markdown|mdown|mkd)$/i.test(path);
  const absolutePath = rootPath.replace(/\\/g, "/").replace(/\/$/, "") + "/" + path;
  const documentUrl = "file://" + (absolutePath.startsWith("/") ? "" : "/") + absolutePath.split("/").map(encodeURIComponent).join("/").replace(/^([/]?)([A-Za-z])%3A/, "$1$2:");

  useEffect(() => {
    let active = true;
    const request = target.kind === "doc"
      ? client.request("docs.read", { workspaceId, path })
      : client.request("domain.instruction.read", { workspaceId, domainId: target.domainId });
    void request.then((result) => {
      if (active) { setContent(result.content); setSaved(result.content); }
    }).catch((cause: unknown) => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [client, workspaceId, path, target.kind, target.kind === "maintainer" ? target.domainId : undefined]);

  const save = async () => {
    if (content === undefined || saving || !dirty) return;
    setSaving(true);
    setError(undefined);
    try {
      if (target.kind === "doc") await client.request("docs.write", { workspaceId, path, content });
      else await client.request("domain.instruction.write", { workspaceId, domainId: target.domainId, content });
      setSaved(content);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setSaving(false); }
  };

  return (
    <Modal title={path} onClose={close} width={markdown ? 1280 : 960} height="78vh" resizable>
      <div className="flex h-full flex-col" onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); }
      }}>
        {content === undefined ? (
          !error && <div className="p-4 text-caption text-muted-foreground">加载中…</div>
        ) : (
          <div className="flex min-h-0 flex-1">
            <section className="flex min-w-0 flex-1 flex-col" aria-label="源码栏">
              <PanelHeader title="源码" />
              <div className="min-h-0 flex-1"><SourceEditor path={path} value={content} onChange={setContent} initialLine={line} initialColumn={column} /></div>
            </section>
            {markdown && <section className="flex min-w-0 flex-1 flex-col border-l border-border" aria-label="预览栏">
              <PanelHeader title="预览" />
              <div className="min-h-0 flex-1 overflow-auto p-4"><MarkdownPreview content={content} documentUrl={documentUrl} /></div>
            </section>}
          </div>
        )}
        {error && <InlineNotice tone="error">{error}</InlineNotice>}
        <footer className="mt-auto flex h-10 shrink-0 items-center gap-3 border-t border-border px-4">
          <span role="status" className="text-caption text-muted-foreground">
            {saving ? "保存中…" : content === undefined ? "尚未加载" : dirty ? "未保存 · Ctrl+S" : "已保存"}
          </span>
          <Button size="sm" variant="primary" className="ml-auto" disabled={!dirty || saving} onClick={() => void save()}>保存</Button>
        </footer>
      </div>
    </Modal>
  );
};
