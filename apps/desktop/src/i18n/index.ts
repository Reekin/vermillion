import type { Locale } from "@vermillion/shared";
import { catalog } from "./messages/index.js";

export type { Locale };
type Catalog = typeof catalog.zh;
export type MessageKey = keyof Catalog;
export type MessageArgs<K extends MessageKey> = Catalog[K] extends (params: infer P) => string ? [params: P] : [];

let current: Locale = "zh";
const listeners = new Set<() => void>();

export const getLocale = (): Locale => current;

export const setLocale = (locale: Locale): void => {
  if (locale === current) return;
  current = locale;
  if (typeof document !== "undefined") document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  for (const listener of listeners) listener();
};

export const subscribeLocale = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Text for `key` in an explicit language (main process, tests). */
export const translate = <K extends MessageKey>(locale: Locale, key: K, ...args: MessageArgs<K>): string => {
  const message = catalog[locale][key] as string | ((params: unknown) => string);
  return typeof message === "function" ? message(args[0]) : message;
};

/** Text for `key` in the current interface language. Components that render it call `useT()` so they re-render on a language switch. */
export const t = <K extends MessageKey>(key: K, ...args: MessageArgs<K>): string => translate(current, key, ...args);

/** Looks up a key known only at runtime (service codes); undefined when the catalog has no such key. */
export const translateDynamic = (key: string, params?: Record<string, unknown>): string | undefined => {
  if (!Object.hasOwn(catalog[current], key)) return undefined;
  const message = catalog[current][key as MessageKey] as string | ((params: unknown) => string);
  return typeof message === "function" ? message(params ?? {}) : message;
};

export const intlLocale = (locale: Locale = current): string => (locale === "zh" ? "zh-CN" : "en-US");
