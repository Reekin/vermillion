import { useMemo, useState, type ReactElement } from "react";
import {
  summarizeUnifiedDiff,
  type CodexChangedFileRpc
} from "@vermillion/shared";
import { DiffDialog } from "../../../ui/app/components/DiffDialog.js";
import { Button } from "../../../ui/chat-shell/Button.js";

export type CodexTurnChangesExtensionProps = {
  sessionId: string;
  turnId: string;
  /** Session working directory; paths under it are shown relative. */
  cwd?: string;
  changedFiles: CodexChangedFileRpc[];
  canUndo: boolean;
  onUndoTurn?: (input: {
    sessionId: string;
    turnId: string;
  }) => Promise<{
    undone: boolean;
    errorMessage?: string;
  }>;
};

const normalize = (path: string): string => path.replace(/\\/g, "/");

/** `cwd`-relative path with forward slashes; falls back to the absolute path outside the workspace. */
const relativeTo = (cwd: string | undefined, path: string): string => {
  const target = normalize(path);
  if (!cwd) return target;
  const root = normalize(cwd).replace(/\/+$/, "") + "/";
  return target.toLowerCase().startsWith(root.toLowerCase()) ? target.slice(root.length) : target;
};

const changeKindLabel: Record<CodexChangedFileRpc["changeKind"], string> = {
  add: "A",
  delete: "D",
  update: "M"
};

export const CodexTurnChangesExtension = ({
  sessionId,
  turnId,
  cwd,
  changedFiles,
  canUndo,
  onUndoTurn
}: CodexTurnChangesExtensionProps): ReactElement | null => {
  const mergedDiff = useMemo(
    () =>
      changedFiles
        .map((file) => file.diff?.trim())
        .filter((diff): diff is string => Boolean(diff))
        .join("\n"),
    [changedFiles]
  );
  const summary = useMemo(() => summarizeUnifiedDiff(mergedDiff), [mergedDiff]);
  const [diffPath, setDiffPath] = useState<string>();
  const [isUndoing, setIsUndoing] = useState(false);
  const [undoError, setUndoError] = useState<string | undefined>();
  const [isUndone, setIsUndone] = useState(false);

  // After a cold start, history restores file names without diff bodies; there is nothing worth showing then.
  if (changedFiles.length === 0 || !mergedDiff) {
    return null;
  }

  const onUndo = async (): Promise<void> => {
    if (!onUndoTurn || isUndoing || isUndone) {
      return;
    }
    setIsUndoing(true);
    setUndoError(undefined);
    try {
      const result = await onUndoTurn({ sessionId, turnId });
      if (!result.undone) {
        setUndoError(result.errorMessage ?? "撤销失败。");
        return;
      }
      setIsUndone(true);
    } catch (error) {
      setUndoError((error as Error).message);
    } finally {
      setIsUndoing(false);
    }
  };

  return (
    <section className="vm-changes" aria-label="文件变更">
      <header className="vm-changes__header">
        <span className="vm-changes__title">{summary.fileCount} 个文件变更</span>
        <span className="vm-changes__stats">
          <span className="is-add">+{summary.linesAdded}</span>
          <span className="is-delete">−{summary.linesDeleted}</span>
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="vm-changes__undo"
          onClick={() => void onUndo()}
          disabled={!onUndoTurn || !canUndo || isUndoing || isUndone}
        >
          {isUndone ? "已撤销" : isUndoing ? "撤销中…" : "撤销"}
        </Button>
      </header>
      {undoError && <p className="vm-changes__notice" role="alert">{undoError}</p>}
      {isUndone && <p className="vm-changes__notice">本轮改动已在本地撤销。</p>}
      <ul className="vm-changes__list">
        {changedFiles.map((file) => {
          const fileSummary = summarizeUnifiedDiff(file.diff);
          const relative = relativeTo(cwd, file.displayPath);
          const slash = relative.lastIndexOf("/");
          return (
            <li key={file.displayPath}>
              <button
                type="button"
                className="vm-changes__file"
                onClick={() => setDiffPath(file.displayPath)}
                aria-haspopup="dialog"
                title={file.displayPath}
              >
                <span className={`vm-changes__kind is-${file.changeKind}`}>{changeKindLabel[file.changeKind]}</span>
                <span className="vm-changes__path">
                  {slash >= 0 && <span className="vm-changes__dir"><bdi>{relative.slice(0, slash + 1)}</bdi></span>}
                  <span className="vm-changes__name">{relative.slice(slash + 1)}</span>
                </span>
                <span className="vm-changes__stats">
                  <span className="is-add">+{fileSummary.linesAdded}</span>
                  <span className="is-delete">−{fileSummary.linesDeleted}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {diffPath !== undefined && (
        <DiffDialog
          files={changedFiles.map((file) => ({ path: relativeTo(cwd, file.displayPath), diff: file.diff }))}
          initialPath={relativeTo(cwd, diffPath)}
          onClose={() => setDiffPath(undefined)}
        />
      )}
    </section>
  );
};
