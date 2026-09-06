import { z } from "zod";

export const zRoleDocument = z.object({
  body: z.string(),
  mode: z.enum(["override", "append"]),
  model: z.string().min(1).optional(),
  reasoningOptionId: z.string().min(1).nullable().optional(),
  serviceTierId: z.string().min(1).nullable().optional(),
  /** Unedited frontmatter entries are kept when saving the role. */
  extraHeader: z.string().default("")
});
export type RoleDocument = z.infer<typeof zRoleDocument>;

const settingLine = /^(mode|model|reasoningOptionId|serviceTierId):[ \t]*(.*)$/;

/** Role settings are top-level scalar frontmatter fields; the body is never trimmed. */
export const parseRoleDocument = (content: string): RoleDocument => {
  const header = content.match(/^\uFEFF?---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m);
  if (!header || header.index !== 0) return { body: content, mode: "override", extraHeader: "" };
  const settings: Record<string, unknown> = {};
  const extra: string[] = [];
  for (const line of header[1]!.split(/\r?\n/)) {
    const match = line.match(settingLine);
    if (!match) { extra.push(line); continue; }
    const scalar = match[2]!.trim();
    const quoted = scalar.match(/^("(?:\\.|[^"\\])*"|'(?:''|[^'])*')(?:[ \t]+#.*)?$/);
    const value = quoted
      ? quoted[1]!.startsWith('"') ? JSON.parse(quoted[1]!) : quoted[1]!.slice(1, -1).replace(/''/g, "'")
      : scalar.replace(/[ \t]+#.*$/, "").trim();
    if (!quoted && (value === "null" || value === "~" || value === "")) {
      settings[match[1]!] = match[1] === "mode" || match[1] === "model" ? undefined : null;
    } else {
      settings[match[1]!] = value;
    }
  }
  return zRoleDocument.parse({ ...settings, mode: settings.mode ?? "override", body: content.slice(header[0].length), extraHeader: extra.join("\n").trimEnd() });
};

export const serializeRoleDocument = (document: RoleDocument): string => {
  const { body, extraHeader, ...settings } = zRoleDocument.parse(document);
  const lines = Object.entries(settings)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => key + ": " + JSON.stringify(value));
  return "---\n" + [...(extraHeader ? [extraHeader] : []), ...lines].join("\n") + "\n---\n" + body;
};
