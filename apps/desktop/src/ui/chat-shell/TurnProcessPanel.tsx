import type {
  ApprovalRequest,
  MessageBlock,
  RuntimeInteraction
} from "@vermillion/shared";
import type { ReactElement } from "react";
import { compareTranscriptItems } from "./transcript-order.js";
import { useT } from "../../i18n/react.js";
import type { ImageLightboxState } from "./ImageLightbox.js";
import {
  MessageMarkdownView,
  type RenderMessageFileLinkMenu
} from "./MessageMarkdownView.js";
import type { ParticipantDirectory } from "./participant-directory.js";
import type { TurnTranscriptRow } from "./transcript-view-model.js";
import { ApprovalFlowView, type ApprovalAction } from "./ApprovalFlowView.js";
import {
  InteractionFlowView,
  type InteractionResponseInput
} from "./InteractionFlowView.js";
import {
  buildProcessActivityEntries,
  ProcessActivityItemView,
  ProcessActivityView,
  type ProcessActivityEntry
} from "./ProcessActivityView.js";

export type TurnProcessPanelProps = {
  collapseActivity?: boolean;
  chineseLabels?: boolean;
  row: TurnTranscriptRow;
  hiddenRows?: TurnTranscriptRow[];
  participantDirectory: ParticipantDirectory;
  onPreviewImage?: (input: ImageLightboxState) => void;
  renderFileLinkContextMenu?: RenderMessageFileLinkMenu;
  onRespondApproval?: (input: {
    sessionId: string;
    requestId: string;
    action: ApprovalAction;
    decision?: string | Record<string, unknown>;
    payload?: Record<string, unknown>;
  }) => Promise<void>;
  onRespondInteraction?: (input: InteractionResponseInput) => Promise<void>;
};

type TurnHistoryItem =
  | {
      kind: "message";
      id: string;
      startedAt?: string;
      blocks: MessageBlock[];
    }
  | {
      kind: "activity";
      id: string;
      startedAt?: string;
      entry: ProcessActivityEntry;
    }
  | {
      kind: "approval";
      id: string;
      startedAt: string;
      approval: ApprovalRequest;
    }
  | {
      kind: "interaction";
      id: string;
      startedAt: string;
      interaction: RuntimeInteraction;
    };

const buildHiddenMessageItems = (
  hiddenRows: TurnTranscriptRow[]
): TurnHistoryItem[] => {
  const messageGroups = new Map<
    string,
    { blocks: MessageBlock[]; fallbackStartedAt?: string }
  >();

  for (const hiddenRow of hiddenRows) {
    for (const block of hiddenRow.blocks) {
      const current = messageGroups.get(block.messageId);
      if (current) {
        current.blocks.push(block);
        continue;
      }
      messageGroups.set(block.messageId, {
        blocks: [block],
        fallbackStartedAt: hiddenRow.startedAt
      });
    }
  }

  return [...messageGroups.entries()].map(([messageId, group]) => ({
    kind: "message" as const,
    id: `message:${messageId}`,
    startedAt:
      group.blocks.find((block) => block.startedAt)?.startedAt ??
      group.fallbackStartedAt,
    blocks: group.blocks
  }));
};

export const buildTurnHistoryItems = (
  row: TurnTranscriptRow,
  hiddenRows: TurnTranscriptRow[]
): TurnHistoryItem[] =>
  [
    ...buildHiddenMessageItems(hiddenRows),
    ...buildProcessActivityEntries(row.toolCalls, row.terminalStreams).map((entry) => ({
      kind: "activity" as const,
      id: entry.id,
      startedAt: entry.startedAt,
      entry
    })),
    ...row.approvals.map((approval) => ({
      kind: "approval" as const,
      id: `approval:${approval.requestId}`,
      startedAt: approval.requestedAt,
      approval
    })),
    ...(row.interactions ?? []).map((interaction) => ({
      kind: "interaction" as const,
      id: `interaction:${interaction.requestId}`,
      startedAt: interaction.requestedAt,
      interaction
    }))
  ].sort(compareTranscriptItems(row.turn));

export const TurnProcessPanel = ({
  collapseActivity = false,
  chineseLabels = false,
  row,
  hiddenRows = [],
  participantDirectory,
  onPreviewImage,
  renderFileLinkContextMenu,
  onRespondApproval,
  onRespondInteraction
}: TurnProcessPanelProps): ReactElement => {
  const t = useT();
  const interactions = row.interactions ?? [];
  const historyItems =
    hiddenRows.length > 0 ? buildTurnHistoryItems(row, hiddenRows) : [];
  const renderStandaloneActivity = historyItems.length === 0;

  return (
    <div className="awb-turn-process">
      {historyItems.length > 0 && (
        <div className="awb-process-steps awb-turn-process__history">
            {historyItems.map((item) => {
              if (item.kind === "activity") {
                return (
                  <ProcessActivityItemView
                    key={item.id}
                    entry={item.entry}
                    onPreviewImage={onPreviewImage}
                  />
                );
              }
              if (item.kind === "approval") {
                return (
                  <ApprovalFlowView
                    chineseLabels={chineseLabels}
                    key={item.id}
                    approvals={[item.approval]}
                    participantDirectory={participantDirectory}
                    onRespond={onRespondApproval}
                  />
                );
              }
              if (item.kind === "interaction") {
                return (
                  <InteractionFlowView
                    chineseLabels={chineseLabels}
                    key={item.id}
                    interactions={[item.interaction]}
                    participantDirectory={participantDirectory}
                    onRespond={onRespondInteraction}
                  />
                );
              }
              return (
                <div key={item.id} className="awb-process-step__message">
                  {item.blocks.map((block) => (
                    <MessageMarkdownView
                      key={block.blockId}
                      block={block}
                      onPreviewImage={onPreviewImage}
                      renderFileLinkContextMenu={renderFileLinkContextMenu}
                    />
                  ))}
                </div>
              );
            })}
        </div>
      )}

      {renderStandaloneActivity &&
        (row.toolCalls.length > 0 || row.terminalStreams.length > 0) && (
          collapseActivity ? <details className="awb-mobile-activity">
            <summary>工具与终端输出 · {row.toolCalls.length + row.terminalStreams.length}</summary>
            <ProcessActivityView turn={row.turn} toolCalls={row.toolCalls} terminalStreams={row.terminalStreams} onPreviewImage={onPreviewImage} />
          </details> : <ProcessActivityView
            turn={row.turn}
            toolCalls={row.toolCalls}
            terminalStreams={row.terminalStreams}
            onPreviewImage={onPreviewImage}
          />
        )}

      {renderStandaloneActivity && row.approvals.length > 0 && (
        <section className="awb-turn-process__section">
          <header className="awb-turn-process__section-header">
            <h4>{t("session.approvalRequests")}</h4>
            <span>{row.approvals.length}</span>
          </header>
          <ApprovalFlowView
            chineseLabels={chineseLabels}
            approvals={row.approvals}
            participantDirectory={participantDirectory}
            onRespond={onRespondApproval}
          />
        </section>
      )}

      {renderStandaloneActivity && interactions.length > 0 && (
        <section className="awb-turn-process__section">
          <header className="awb-turn-process__section-header">
            <h4>{t("session.pendingQuestions")}</h4>
            <span>{interactions.length}</span>
          </header>
          <InteractionFlowView
            chineseLabels={chineseLabels}
            interactions={interactions}
            participantDirectory={participantDirectory}
            onRespond={onRespondInteraction}
          />
        </section>
      )}
    </div>
  );
};
