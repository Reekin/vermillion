type FileChangeKind =
  | { type: "add" }
  | { type: "delete" }
  | { type: "update"; move_path: string | null };

type FileChangeDiffLike = {
  path: string;
  diff: string;
  kind: FileChangeKind;
};

const trimOuterNewlines = (value: string): string =>
  value.replace(/^(?:\r?\n)+|(?:\r?\n)+$/g, "");

const normalizePatchPath = (value: string): string =>
  value.replaceAll("\\", "/");

const headerPath = (value: string | undefined, side: "a" | "b"): string =>
  value ? `${side}/${normalizePatchPath(value)}` : "/dev/null";

const looksLikeUnifiedDiff = (diff: string): boolean =>
  /^diff --git /m.test(diff) || /^--- /m.test(diff) || /^\+\+\+ /m.test(diff);

/** Codex reports added and deleted files by their full content; this turns it into one hunk. */
const contentHunk = (content: string, kind: "add" | "delete"): string | undefined => {
  const body = content.replace(/\r?\n$/, "");
  if (!body) {
    return undefined;
  }
  const lines = body.split(/\r?\n/);
  const range = `1,${lines.length}`;
  const marker = kind === "add" ? "+" : "-";
  return [
    kind === "add" ? `@@ -0,0 +${range} @@` : `@@ -${range} +0,0 @@`,
    ...lines.map((line) => marker + line)
  ].join("\n");
};

export const normalizeFileChangeDiff = (change: FileChangeDiffLike): string | undefined => {
  const diff = change.kind.type === "update"
    ? trimOuterNewlines(change.diff)
    : contentHunk(change.diff, change.kind.type);
  if (!diff) {
    return undefined;
  }
  if (change.kind.type === "update" && looksLikeUnifiedDiff(diff)) {
    return diff;
  }

  const nextPath = normalizePatchPath(change.path);
  const previousPath =
    change.kind.type === "update" && change.kind.move_path
      ? normalizePatchPath(change.kind.move_path)
      : nextPath;
  const oldPath = change.kind.type === "add" ? undefined : previousPath;
  const newPath = change.kind.type === "delete" ? undefined : nextPath;
  const diffPath = newPath ?? oldPath ?? nextPath;

  return [
    `diff --git a/${diffPath} b/${diffPath}`,
    `--- ${headerPath(oldPath, "a")}`,
    `+++ ${headerPath(newPath, "b")}`,
    diff
  ].join("\n");
};

export const mergeFileChangeDiffs = (changes: readonly FileChangeDiffLike[]): string | undefined => {
  const normalized = changes
    .map((change) => normalizeFileChangeDiff(change))
    .filter((diff): diff is string => Boolean(diff));
  if (normalized.length === 0) {
    return undefined;
  }
  return normalized.join("\n");
};
