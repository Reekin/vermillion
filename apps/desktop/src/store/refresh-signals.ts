import {
  invalidatesSessionBrowser,
  type RuntimeEvent
} from "@vermillion/shared";

export type RendererRefreshSignals = {
  sessionBrowser: number;
  chatTree: number;
  engineExtensions: number;
  engineConfigWarnings: number;
  settings: number;
};

export const createInitialRendererRefreshSignals = (): RendererRefreshSignals => ({
  sessionBrowser: 0,
  chatTree: 0,
  engineExtensions: 0,
  engineConfigWarnings: 0,
  settings: 0
});

const increment = (value: number): number => value + 1;

const invalidatesChatTree = (event: RuntimeEvent): boolean => {
  switch (event.type) {
    case "conversationGraph.updated":
    case "turn.started":
    case "session.disposed":
      return true;
    case "session.created":
      return Boolean(event.relation);
    default:
      return false;
  }
};

const invalidatesEngineExtensions = (event: RuntimeEvent): boolean =>
  event.type === "engineExtension.updated";

export const advanceRendererRefreshSignals = (
  current: RendererRefreshSignals,
  event: RuntimeEvent
): RendererRefreshSignals => {
  if (event.type === "engine.configWarnings.updated") {
    return { ...current, engineConfigWarnings: increment(current.engineConfigWarnings) };
  }
  if (event.type === "settings.updated") {
    return { ...current, settings: increment(current.settings) };
  }
  const sessionBrowserChanged = invalidatesSessionBrowser(event);
  const chatTreeChanged = invalidatesChatTree(event);
  const engineExtensionsChanged = invalidatesEngineExtensions(event);

  if (
    !sessionBrowserChanged &&
    !chatTreeChanged &&
    !engineExtensionsChanged
  ) {
    return current;
  }

  return {
    ...current,
    sessionBrowser: sessionBrowserChanged
      ? increment(current.sessionBrowser)
      : current.sessionBrowser,
    chatTree: chatTreeChanged ? increment(current.chatTree) : current.chatTree,
    engineExtensions: engineExtensionsChanged
      ? increment(current.engineExtensions)
      : current.engineExtensions
  };
};
