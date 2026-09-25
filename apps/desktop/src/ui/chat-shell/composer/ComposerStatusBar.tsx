import { useEffect, useRef, useState, type ReactElement } from "react";
import { writeClipboardText } from "../clipboard.js";
import type {
  ComposerStatusModel,
  ComposerStatusNotice
} from "../composer-status.js";
import {
  countUnseenNotices,
  engineWarningDetails,
  noticeEntryDetails,
  type EngineConfigWarningView,
  type NoticeLogEntry
} from "../notice-log.js";

export type NoticeLogView = {
  entries: NoticeLogEntry[];
  engineWarnings: EngineConfigWarningView[];
  onOpen: () => void;
  onClear: () => void;
};

const severityLabel = { info: "信息", warning: "警告", error: "错误" } as const;

const sourceLabels: Record<NonNullable<ComposerStatusNotice["source"]>, string> = {
  "engine-list": "引擎列表",
  "engine-select": "引擎选择",
  subscription: "事件订阅",
  send: "发送",
  "create-session": "新建会话",
  approval: "审批",
  "workspace-add": "添加 workspace",
  "workspace-action": "workspace 操作",
  "session-browser": "会话列表",
  "session-action": "会话操作",
  "chat-tree": "会话树",
  delegation: "委派",
  settings: "设置"
};

const formatTime = (at: string): string =>
  new Date(at).toLocaleTimeString([], { hour12: false });

const LogItem = ({
  meta,
  message,
  details
}: {
  meta: string;
  message: string;
  details?: string;
}): ReactElement => {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    void writeClipboardText(details ? `${message}\n\n${details}` : message).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    }, () => undefined);
  };
  return (
    <li className="awb-notice-log__item">
      <div className="awb-notice-log__meta">
        <span>{meta}</span>
        <span className="awb-notice-log__item-actions">
          {details ? (
            <button type="button" onClick={() => setExpanded((value) => !value)}>
              {expanded ? "收起详情" : "详情"}
            </button>
          ) : null}
          <button type="button" onClick={copy}>{copied ? "已复制" : "复制"}</button>
        </span>
      </div>
      <p className="awb-notice-log__message">{message}</p>
      {expanded && details ? <pre className="awb-notice-log__details">{details}</pre> : null}
    </li>
  );
};

export const ComposerStatusBar = ({
  status,
  notice,
  log
}: {
  status: ComposerStatusModel;
  notice?: ComposerStatusNotice;
  log?: NoticeLogView;
}): ReactElement => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const onOpen = log?.onOpen;

  useEffect(() => {
    if (!open) return;
    onOpen?.();
    const closeOnOutside = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open, onOpen]);

  const hasLog = Boolean(log && (log.entries.length || log.engineWarnings.length));
  const unseen = log ? countUnseenNotices(log.entries) : 0;
  const warned = Boolean(log?.engineWarnings.length);
  const toggle = (): void => setOpen((value) => !value);

  return (
    <div className="awb-composer-status" ref={rootRef}>
      <span className={`awb-composer-status__pill is-${status.kind}`} role="status">
        {status.kind === "no_session" || status.kind === "idle" ? "就绪"
          : status.kind === "running" ? "运行中"
          : status.kind === "awaiting_approval" ? "等待审批"
          : status.kind === "error" ? "需要处理" : status.label}
      </span>
      {hasLog ? (
        <button
          type="button"
          className={`awb-composer-status__log${warned ? " is-warning" : ""}`}
          aria-expanded={open}
          aria-label={`提示记录${warned ? "，有引擎配置警告" : ""}${unseen ? `，${unseen} 条未查看` : ""}`}
          title="提示记录"
          onClick={toggle}
        >
          <span aria-hidden="true">{warned ? "!" : "≡"}</span>
          {unseen ? <span className="awb-composer-status__log-count">{unseen}</span> : null}
        </button>
      ) : null}
      {notice?.message ? (
        <button
          type="button"
          className={`awb-composer-status__notice is-${notice.severity ?? "info"}`}
          onClick={log ? toggle : undefined}
          role="status"
        >
          {notice.message}
        </button>
      ) : null}
      {open && log ? (
        <div className="awb-notice-log" role="dialog" aria-label="提示记录">
          <div className="awb-notice-log__header">
            <span>提示记录</span>
            <button type="button" onClick={log.onClear} disabled={!log.entries.length}>清空</button>
          </div>
          {hasLog ? (
            <ul className="awb-notice-log__list">
              {log.engineWarnings.map((warning, index) => (
                <LogItem
                  key={`engine-${warning.engineId}-${index}`}
                  meta={`警告 · 引擎配置 · ${warning.engineLabel}`}
                  message={warning.summary}
                  details={engineWarningDetails(warning)}
                />
              ))}
              {log.entries.map((entry) => (
                <LogItem
                  key={entry.id}
                  meta={[
                    formatTime(entry.at),
                    severityLabel[entry.severity ?? "info"],
                    entry.source ? sourceLabels[entry.source] : undefined
                  ].filter(Boolean).join(" · ")}
                  message={entry.message}
                  details={noticeEntryDetails(entry)}
                />
              ))}
            </ul>
          ) : (
            <p className="awb-notice-log__empty">暂无提示</p>
          )}
        </div>
      ) : null}
    </div>
  );
};
