import { useMemo, type ReactElement } from "react";
import { parseUnifiedDiff } from "@vermillion/shared";

/** Added and deleted line counts, "+3 −5". */
export const DiffStat = ({ added, deleted }: { added: number; deleted: number }): ReactElement => (
  <span className="awb-diff-stat">
    <span className="is-add">+{added}</span>
    <span className="is-delete">−{deleted}</span>
  </span>
);

/**
 * A unified diff as hunks with added and deleted lines marked; text that does not parse as a
 * diff is shown as it is. `showPaths` heads each file with its path, for patches spanning files.
 */
export const DiffHunks = ({ diff, showPaths = false }: { diff: string; showPaths?: boolean }): ReactElement => {
  const files = useMemo(() => parseUnifiedDiff(diff), [diff]);
  if (!files.some((file) => file.hunks.length > 0)) {
    return <pre className="awb-diff__raw">{diff}</pre>;
  }
  return (
    <div className="awb-diff">
      {files.map((file, fileIndex) => (
        <div key={fileIndex}>
          {showPaths ? <div className="awb-diff__path">{file.displayPath}</div> : null}
          {file.hunks.map((hunk, hunkIndex) => (
            <section key={hunkIndex}>
              <div className="awb-diff__hunk">{hunk.header}</div>
              <pre>{hunk.lines.map((line, index) => (
                <div key={index} className={`awb-diff__line is-${line.kind}`}>{line.text || " "}</div>
              ))}</pre>
            </section>
          ))}
        </div>
      ))}
    </div>
  );
};
