import type { ReactElement } from "react";
import { formatClock } from "../../../i18n/format.js";
import { useT } from "../../../i18n/react.js";
import { Button } from "../Button.js";
import type { ComposerIntent, QueuedComposerMessage } from "./composer-types.js";

const formatQueuedTime = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return formatClock(date, true);
};

export const ComposerQueue = ({
  queue,
  currentIntent,
  supportsSteer,
  onEdit,
  onDelete,
  onSendNow,
  onSteerNow
}: {
  queue: QueuedComposerMessage[];
  currentIntent: ComposerIntent;
  supportsSteer: boolean;
  onEdit: (messageId: string) => void;
  onDelete: (messageId: string) => void;
  onSendNow: (messageId: string) => Promise<void>;
  onSteerNow: (messageId: string) => Promise<void>;
}): ReactElement | null => {
  const t = useT();
  if (queue.length === 0) {
    return null;
  }

  return (
    <div className="awb-composer-queue" aria-label={t("session.queuedMessages")}>
      {queue.map((item) => (
        <article key={item.id} className="awb-composer-queue__item">
          <div className="awb-composer-queue__copy">
            <strong>
              {item.text ||
                (item.skills.length > 0
                  ? t("session.queuedWithSkills")
                  : t("session.queuedAttachmentsOnly"))}
            </strong>
            <span>
              {t("session.queuedMeta", { skills: item.skills.length, attachments: item.attachments.length })} ·{" "}
              {formatQueuedTime(item.createdAt)}
            </span>
          </div>
          <div className="awb-composer-queue__actions">
            <Button variant="ghost" size="sm" onClick={() => onEdit(item.id)}>
              {t("session.edit")}
            </Button>
            <Button variant="danger" size="sm" onClick={() => onDelete(item.id)}>
              {t("common.delete")}
            </Button>
            {currentIntent === "send" ? (
              <Button variant="secondary" size="sm" onClick={() => void onSendNow(item.id)}>
                {t("session.sendNow")}
              </Button>
            ) : null}
            {supportsSteer && currentIntent !== "send" ? (
              <Button variant="secondary" size="sm" onClick={() => void onSteerNow(item.id)}>
                {t("session.steerNow")}
              </Button>
            ) : null}
          </div>
        </article>
      ))}
    </div>
  );
};
