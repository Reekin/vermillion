/**
 * A message is plain text or a function of typed parameters. Every area defines its Chinese and
 * English messages together; the English side must provide exactly the Chinese keys with the same
 * parameter types, so a missing or mistyped translation fails typecheck.
 */
export type Message = string | ((params: never) => string);

export type Translation<Zh extends Record<string, Message>> = {
  [K in keyof Zh]: Zh[K] extends (params: infer P) => string ? (params: P) => string : string;
};

export const defineMessages = <const Zh extends Record<string, Message>>(zh: Zh, en: Translation<Zh>) => ({ zh, en });

/** English plural: `plural(3, "file")` → "3 files", `plural(1, "file")` → "1 file". */
export const plural = (count: number, singular: string, pluralForm = singular + "s"): string =>
  `${count} ${count === 1 ? singular : pluralForm}`;
