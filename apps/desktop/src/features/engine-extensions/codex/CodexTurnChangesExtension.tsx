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

const pluralize = (count: number, singular: string, plural = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : plural}`;

export const CodexTurnChangesExtension = ({
  sessionId,
  turnId,
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

  if (changedFiles.length === 0) {
    return null;
  }

  const onUndo = async (): Promise<void> => {
    if (!onUndoTurn || isUndoing || isUndone) {
      return;
    }
    setIsUndoing(true);
    setUndoError(undefined);
    try {
      const result = await onUndoTurn({
        sessionId,
        turnId
      });
      if (!result.undone) {
        setUndoError(result.errorMessage ?? "Failed to revert this turn.");
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
    <section className="awb-turn-changes" aria-label="Changed files">
      <header className="awb-turn-changes__header">
        <div className="awb-turn-changes__summary">
          <strong>{pluralize(summary.fileCount, "file")} changed</strong>
          <span className="awb-turn-changes__totals">
            <span className="is-add">+{summary.linesAdded}</span>
            <span className="is-delete">-{summary.linesDeleted}</span>
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void onUndo()}
          disabled={!onUndoTurn || !canUndo || isUndoing || isUndone}
        >
          {isUndone ? "Undone" : isUndoing ? "Undoing…" : canUndo ? "Undo" : "Undo unavailable"}
        </Button>
      </header>
      {undoError ? <p className="awb-turn-changes__notice is-error">{undoError}</p> : null}
      {isUndone ? (
        <p className="awb-turn-changes__notice">Turn changes were reverted locally.</p>
      ) : null}
      <div className="awb-turn-changes__list">
        {changedFiles.map((file) => {
          const fileSummary = summarizeUnifiedDiff(file.diff);
          return (
            <article key={file.displayPath} className="awb-turn-changes__file">
              <button
                type="button"
                className="awb-turn-changes__file-toggle"
                onClick={() => setDiffPath(file.displayPath)}
                aria-haspopup="dialog"
              >
                <span className="awb-turn-changes__file-path">{file.displayPath}</span>
                <span className="awb-turn-changes__file-stats">
                  <span className="is-add">+{fileSummary.linesAdded}</span>
                  <span className="is-delete">-{fileSummary.linesDeleted}</span>
                </span>
              </button>
            </article>
          );
        })}
      </div>
      {diffPath !== undefined && (
        <DiffDialog
          files={changedFiles.map((file) => ({ path: file.displayPath, diff: file.diff }))}
          initialPath={diffPath}
          onClose={() => setDiffPath(undefined)}
        />
      )}
    </section>
  );
};
