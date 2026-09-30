import type { ToolStep, ToolStepObject, ToolStepResult, ToolStepSummary } from "@vermillion/shared";
import { t } from "./index.js";
import { formatDuration, joinList } from "./format.js";

export type ToolStepWords = { verb: string; object?: string; result?: string };

export const toolStepVerb = (step: Pick<ToolStep, "kind" | "agentAction">): string =>
  step.agentAction ? t(`step.agent.${step.agentAction}` as "step.agent.spawn") : t(`step.${step.kind}` as "step.read");

export const toolStepObject = (object: ToolStepObject | undefined): string | undefined => {
  switch (object?.kind) {
    case "text":
      return object.text;
    case "files":
      return object.names.length > 3
        ? t("step.object.moreFiles", { shown: joinList(object.names.slice(0, 3)), total: object.names.length })
        : joinList(object.names);
    case "directories":
      return joinList(object.paths.map((path) => (path === "." ? t("step.object.currentDirectory") : path)));
    case "pattern":
      return `“${object.pattern}”${object.path ? ` · ${object.path === "." ? t("step.object.currentDirectory") : object.path}` : ""}`;
    case "agents":
      return t("step.object.agents", { count: object.count });
    case "terminal":
      return t("step.object.terminal");
    default:
      return undefined;
  }
};

export const toolStepResult = (result: ToolStepResult | undefined): string | undefined => {
  switch (result?.kind) {
    case "running":
      return t("step.result.running");
    case "failed":
      return result.exitCode === undefined ? t("step.result.failed") : t("step.result.failedExit", { exitCode: result.exitCode });
    case "output":
      return result.lines > 0 ? t("step.result.lines", { lines: result.lines }) : t("step.result.noOutput");
    case "diff":
      return `+${result.added} −${result.deleted}`;
    case "agents":
      return result.errored > 0 ? t("step.result.agentsErrored", { count: result.errored })
        : result.completed > 0 ? t("step.result.agentsCompleted", { count: result.completed })
          : t("step.result.agentsUnfinished");
    default:
      return undefined;
  }
};

/** A step in the interface language: "读取 README.md · 输出 3 行" / "Read README.md · 3 lines". */
export const toolStepWords = (step: ToolStep): ToolStepWords => {
  const object = toolStepObject(step.object);
  const result = toolStepResult(step.result);
  return { verb: toolStepVerb(step), ...(object ? { object } : {}), ...(result ? { result } : {}) };
};

/** "列目录 1 次 · 读取 2 个文件 · 1 分 27 秒"; empty when the turn has nothing to summarize. */
export const toolSummaryText = (summary: ToolStepSummary): string => {
  const parts = summary.counts.map(({ kind, count }) =>
    kind === "compact" ? t("summary.compact") : t(`summary.${kind}` as "summary.read", { count }));
  if (summary.messageCount) parts.push(t("summary.messages", { count: summary.messageCount }));
  if (summary.failures > 0) parts.push(t("summary.failures", { count: summary.failures }));
  if (summary.durationMs) parts.push(formatDuration(summary.durationMs));
  return parts.join(" · ");
};
