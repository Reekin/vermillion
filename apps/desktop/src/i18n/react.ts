import { useSyncExternalStore } from "react";
import { getLocale, subscribeLocale, t, type Locale } from "./index.js";

export const useLocale = (): Locale => useSyncExternalStore(subscribeLocale, getLocale);

/**
 * Subscribes the component to the interface language and returns `t`. Every component that renders
 * translated text, directly or through a helper, calls this so a language switch re-renders it.
 */
export const useT = (): typeof t => {
  useLocale();
  return t;
};
