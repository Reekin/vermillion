import { useSyncExternalStore } from "react";
import type { RendererStore } from "../../store/store.js";

/** Changes whenever an engine reports new configuration warnings; other renderer state does not re-render the caller. */
export const useEngineConfigWarningsSignal = (store: RendererStore): number =>
  useSyncExternalStore(
    (onChange) => store.subscribeMeta(onChange),
    () => store.getSubscriptionSnapshot().state.refreshSignals.engineConfigWarnings
  );
