import { useMemo, type ReactElement } from "react";
import type { CodexHookRunRpc } from "@vermillion/shared";
import { useT } from "../../../i18n/react.js";

export type CodexHookActivityExtensionProps = {
  runs: CodexHookRunRpc[];
};

const statusLabel = (run: CodexHookRunRpc): string =>
  run.durationMs != null && run.status !== "running"
    ? `${run.status} · ${run.durationMs}ms`
    : run.status;

const titleForRun = (run: CodexHookRunRpc): string =>
  `${run.eventName} · ${run.handlerType}`;

const detailForRun = (run: CodexHookRunRpc): string =>
  [run.executionMode, run.scope, run.source]
    .filter((value) => value.trim().length > 0)
    .join(" · ");

const outputTextForRun = (run: CodexHookRunRpc): string | undefined => {
  const lines = [
    ...(run.statusMessage ? [`status: ${run.statusMessage}`] : []),
    ...run.entries.map((entry) => `${entry.kind}: ${entry.text}`)
  ];
  const text = lines.join("\n").trim();
  return text || undefined;
};

export const CodexHookActivityExtension = ({
  runs
}: CodexHookActivityExtensionProps): ReactElement | null => {
  const t = useT();
  const sortedRuns = useMemo(
    () =>
      [...runs].sort((left, right) => {
        if (left.startedAt !== right.startedAt) {
          return left.startedAt - right.startedAt;
        }
        if (left.displayOrder !== right.displayOrder) {
          return left.displayOrder - right.displayOrder;
        }
        return left.id.localeCompare(right.id);
      }),
    [runs]
  );

  if (sortedRuns.length === 0) {
    return null;
  }

  return (
    <section className="vm-changes" aria-label={t("session.hookActivity")}>
      <header className="vm-changes__header">
        <span className="vm-changes__title">{t("session.hookActivity")}</span>
        <span className="vm-changes__stats">{t("session.hookRunCount", { count: sortedRuns.length })}</span>
      </header>
      <ul className="vm-changes__list">
        {sortedRuns.map((run) => {
          const outputText = outputTextForRun(run);
          return (
            <li key={run.id}>
              <details className="vm-run" open={run.status === "running" || run.status === "failed"}>
                <summary className="vm-run__summary">
                  <span className="vm-run__title">{titleForRun(run)}</span>
                  <span className={`vm-run__status is-${run.status}`}>{statusLabel(run)}</span>
                </summary>
                <div className="vm-run__body">
                  <p className="vm-run__meta">
                    {detailForRun(run)}
                    <code>{run.sourcePath}</code>
                  </p>
                  {outputText ? <pre className="vm-run__output">{outputText}</pre> : <p className="vm-run__meta">{t("session.hookNoOutput")}</p>}
                </div>
              </details>
            </li>
          );
        })}
      </ul>
    </section>
  );
};
