import { createContext, useContext, useEffect, useState } from "react";
import type { SessionNavigation, WorkbenchClient } from "@vermillion/workbench/client";
import { Badge, Button, InlineNotice, ListRow } from "./components/ui.js";

export const SessionNavigationContext = createContext<{
  client: WorkbenchClient;
  open: (navigation: SessionNavigation) => Promise<void>;
} | undefined>(undefined);

const roleLabels: Record<string, string> = {
  "design-partner": "设计伙伴", steward: "管家", worker: "Worker", supervisor: "Supervisor"
};

/** Workbench links belong to the source turn, independently of its engine extensions. */
export const SessionNavigationSlot = ({ sessionId, turnId }: { sessionId: string; turnId: string }) => {
  const context = useContext(SessionNavigationContext);
  const [links, setLinks] = useState<SessionNavigation[]>([]);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!context) return;
    let disposed = false;
    let generation = 0;
    setLinks([]);
    setError(undefined);
    const load = async () => {
      const current = ++generation;
      try {
        const result = await context.client.request("sessionNavigation.list", { sessionId, turnId });
        if (!disposed && current === generation) { setLinks(result); setError(undefined); }
      } catch (caught) {
        if (!disposed && current === generation) setError((caught as Error).message);
      }
    };
    const unsubscribe = context.client.subscribe((event) => {
      if (event.type === "sessionNavigation.changed" && event.sessionId === sessionId) void load();
    });
    void load();
    return () => { disposed = true; unsubscribe(); };
  }, [context, sessionId, turnId]);
  if (!context || (!links.length && !error)) return null;
  const open = async (link: SessionNavigation) => {
    setError(undefined);
    try { await context.open(link); }
    catch (caught) { setError((caught as Error).message); }
  };
  return <div aria-label="会话导航">
    {links.map((link) => <ListRow key={link.navigationId}
      leading={<Badge>{roleLabels[link.role] ?? link.role}</Badge>}
      title={link.title}
      meta={link.reason}
      trailing={<Button variant="ghost" outlined size="sm" onClick={() => void open(link)}>前往会话</Button>}
    />)}
    {error && <InlineNotice tone="error">{error}</InlineNotice>}
  </div>;
};
