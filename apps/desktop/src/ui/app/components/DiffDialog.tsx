import { useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "../../chat-shell/Button.js";
import { DiffHunks } from "../../chat-shell/DiffView.js";
import { Modal } from "./Modal.js";
import { useT } from "../../../i18n/react.js";

export type DiffDialogFile = { path: string; diff?: string };

/** A snapshot supplied by the caller; viewing it never reads or writes files. */
export const DiffDialog = ({ files, initialPath, loading, error, onClose }: {
  files: DiffDialogFile[];
  initialPath?: string;
  loading?: boolean;
  error?: string;
  onClose: () => void;
}) => {
  const t = useT();
  const [selectedPath, setSelectedPath] = useState(initialPath ?? files[0]?.path);
  const selected = files.find((file) => file.path === selectedPath) ?? files[0];

  return createPortal(
    <Modal title={t("docs.diff.title")} width={1040} height="78vh" onClose={onClose}>
      <div className="vm-diff">
        {files.length > 1 && (
          <nav className="vm-diff__files" aria-label={t("docs.diff.files")}>
            {files.map((file) => (
              <Button key={file.path} size="sm" variant="ghost"
                aria-pressed={file.path === selected?.path}
                onClick={() => setSelectedPath(file.path)}>{file.path}</Button>
            ))}
          </nav>
        )}
        <div className="vm-diff__heading">
          <strong>{selected?.path}</strong>
          <span>{t("docs.diff.legend")}</span>
        </div>
        <div key={selected?.path} className="vm-diff__content" tabIndex={0} aria-label={t("docs.diff.content")}>
          {loading ? <p role="status">{t("docs.diff.loading")}</p> : error ? <p role="alert">{error}</p> :
            !selected?.diff?.trim() ? <p>{t("docs.diff.empty")}</p> :
            <DiffHunks diff={selected.diff} />}
        </div>
      </div>
    </Modal>, document.body
  );
};
