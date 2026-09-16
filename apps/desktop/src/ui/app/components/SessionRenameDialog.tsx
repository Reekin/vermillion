import { useState } from "react";
import { Modal } from "./Modal.js";
import { Button, Field, InlineNotice } from "./ui.js";

type SessionRenameDialogProps = {
  /** Current title; the input starts with it filled in and selected. */
  title: string;
  busy: boolean;
  error: string | undefined;
  onSubmit: (title: string) => void;
  onClose: () => void;
};

/** Renames one session row. Blank titles and titles that keep the current name are not submitted. */
export const SessionRenameDialog = ({ title, busy, error, onSubmit, onClose }: SessionRenameDialogProps) => {
  const [value, setValue] = useState(title);
  const next = value.trim();
  const submit = () => {
    if (next && next !== title && !busy) onSubmit(next);
  };
  return (
    <Modal title="重命名会话" onClose={onClose} width={460}>
      <form
        className="space-y-3 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Field
          label="会话标题"
          autoFocus
          disabled={busy}
          value={value}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setValue(event.target.value)}
        />
        {error && <InlineNotice tone="error">{error}</InlineNotice>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" type="submit" disabled={busy || !next || next === title}>{busy ? "保存中…" : "保存"}</Button>
        </div>
      </form>
    </Modal>
  );
};
