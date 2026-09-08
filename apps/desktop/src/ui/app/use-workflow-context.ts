import { useEffect, useState } from "react";
import type { AgentRun, DecisionCard, WorkbenchClient, WorkflowAction, WorkItem } from "@vermillion/workbench/client";

type Context = { decisions: DecisionCard[]; actions: WorkflowAction[]; workItems: WorkItem[]; runs: AgentRun[] };

/** Inbox spans workspaces; each card follows its own workspace's events. */
export const useWorkflowContext = (client: WorkbenchClient, workspaceId: string) => {
  const [data, setData] = useState<Context>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    let generation = 0;
    const refresh = async () => {
      const request = ++generation;
      try {
        const [decisions, actions, workItems, runs] = await Promise.all([
          client.request("decision.list", { workspaceId }), client.request("action.list", { workspaceId }),
          client.request("workItem.list", { workspaceId }), client.request("run.list", { workspaceId })
        ]);
        if (active && request === generation) { setData({ decisions, actions, workItems, runs }); setError(undefined); }
      } catch (caught) {
        if (active && request === generation) setError(caught instanceof Error ? caught.message : String(caught));
      }
    };
    void refresh();
    const unsubscribe = client.subscribe((event) => {
      if ("workspaceId" in event && event.workspaceId === workspaceId && ["decisions.changed", "actions.changed", "workItems.changed", "runs.changed"].includes(event.type)) void refresh();
    });
    return () => { active = false; unsubscribe(); };
  }, [client, workspaceId]);
  return { data, error };
};
