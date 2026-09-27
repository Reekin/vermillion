import { useState } from "react";
import type { Issue, WorkbenchClient } from "@vermillion/workbench/client";
import { useT } from "../../../i18n/react.js";
import { Modal } from "./Modal.js";
import { Button, Field, InlineNotice, Select } from "./ui.js";

export const CreateWorkItemDialog = ({ client, workspaceId, issue, onClose }: {
  client: WorkbenchClient; workspaceId: string; issue?: Issue; onClose: () => void;
}) => {
  const t = useT();
  const [title, setTitle] = useState(issue?.title ?? "");
  const [objective, setObjective] = useState(issue?.summary ?? "");
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
        workspaceId, issueId: issue?.issueId, title: title.trim(), objective: objective.trim(), risk,
        scope: { inScope: [], outOfScope: [], allowedPaths: lines(paths) },
        acceptance: lines(acceptance).map((text) => ({ text })),
        refs: lines(refs).map((path) => ({ path, commit: commit.trim() }))
      });
      onClose();
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };
  return <Modal title={t("work.create.title")} onClose={onClose} width={560}>
    <form className="space-y-3 p-4" onSubmit={(event) => { event.preventDefault(); if (title.trim() && (!refs.trim() || commit.trim()) && !busy) void submit(); }}>
      <Field label={t("work.create.itemTitle")} autoFocus value={title} onChange={(event) => setTitle(event.target.value)} />
      <Field kind="textarea" label={t("work.create.objective")} value={objective} onChange={(event) => setObjective(event.target.value)} rows={2} />
      <Field kind="textarea" label={t("work.create.refs")} value={refs} onChange={(event) => setRefs(event.target.value)} rows={2} />
      {refs.trim() && <Field label={t("work.create.commit")} value={commit} onChange={(event) => setCommit(event.target.value)} />}
      <Field kind="textarea" label={t("work.create.paths")} value={paths} onChange={(event) => setPaths(event.target.value)} rows={2} />
      <Field kind="textarea" label={t("work.create.acceptance")} value={acceptance} onChange={(event) => setAcceptance(event.target.value)} rows={3} />
      <Select label={t("work.create.risk")} value={risk} onChange={(value) => setRisk(value as typeof risk)}
        options={[{ value: "R0", label: t("work.create.riskR0") }, { value: "R1", label: t("work.create.riskR1") }, { value: "R2", label: t("work.create.riskR2") }]} />
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>{t("common.cancel")}</Button><Button variant="primary" type="submit" disabled={busy || !title.trim() || (!!refs.trim() && !commit.trim())}>{busy ? t("work.create.creating") : t("work.create.title")}</Button></div>
    </form>
  </Modal>;
};
