import { useState } from "react";
import type { WorkbenchClient } from "@vermillion/workbench/client";
import { Modal } from "./Modal.js";
import { Button, Field, InlineNotice } from "./ui.js";

export const CreateWorkItemDialog = ({ client, workspaceId, onClose }: {
  client: WorkbenchClient; workspaceId: string; onClose: () => void;
}) => {
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [paths, setPaths] = useState("");
  const [acceptance, setAcceptance] = useState("");
  const [refs, setRefs] = useState("");
  const [commit, setCommit] = useState("");
  const [risk, setRisk] = useState<"R0" | "R1" | "R2">("R2");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const lines = (text: string) => text.split("\n").map((line) => line.trim()).filter(Boolean);
  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await client.request("workItem.create", {
        workspaceId, title: title.trim(), objective: objective.trim(), risk,
        scope: { inScope: [], outOfScope: [], allowedPaths: lines(paths) },
        acceptance: lines(acceptance).map((text) => ({ text })),
        refs: lines(refs).map((path) => ({ path, commit: commit.trim() }))
      });
      onClose();
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };
  return <Modal title="创建工单" onClose={onClose} width={560}>
    <form className="space-y-3 p-4" onSubmit={(event) => { event.preventDefault(); if (title.trim() && (!refs.trim() || commit.trim()) && !busy) void submit(); }}>
      <Field label="标题" autoFocus value={title} onChange={(event) => setTitle(event.target.value)} />
      <Field kind="textarea" label="目标" value={objective} onChange={(event) => setObjective(event.target.value)} rows={2} />
      <Field kind="textarea" label="引用文档或 Issue（每行一个路径）" value={refs} onChange={(event) => setRefs(event.target.value)} rows={2} />
      {refs.trim() && <Field label="引用版本（commit）" value={commit} onChange={(event) => setCommit(event.target.value)} />}
      <Field kind="textarea" label="允许路径（每行一个）" value={paths} onChange={(event) => setPaths(event.target.value)} rows={2} />
      <Field kind="textarea" label="验收条目（每行一项）" value={acceptance} onChange={(event) => setAcceptance(event.target.value)} rows={3} />
      <Field kind="select" label="风险" value={risk} onChange={(event) => setRisk(event.target.value as typeof risk)}>
        <option value="R0">R0 · 只读</option><option value="R1">R1 · 可丢弃制品</option><option value="R2">R2 · 项目内可回滚</option>
      </Field>
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>取消</Button><Button variant="primary" type="submit" disabled={busy || !title.trim() || (!!refs.trim() && !commit.trim())}>{busy ? "创建中…" : "创建工单"}</Button></div>
    </form>
  </Modal>;
};
