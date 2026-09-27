/**
 * Shared UI primitives for the application shell.
 *
 * Every panel is assembled from these; business components pass content and handlers,
 * primitives own layout, states and typography. See .vermillion/docs/Foundation/UIUX/Standards.md.
 *
 * Buttons       Button, IconButton
 * Text          Badge, StatusPill, StatusIcon, FilterChip, SectionLabel, InlineNotice, Alert, StatusDot, Progress, Steps
 * Fields        Field (input / textarea / number), Select, SegmentedControl, Toggle, Checkbox, Stepper, SettingRow
 * Structure     PageHeader, PanelHeader, Tabs, TabList, ListRow, Card, DisclosureCard, CollapsibleDetails, EmptyState, StatusBar
 * Overlays      HoverCard, Modal (Modal.tsx), ContextMenu (ContextMenu.tsx), DiffDialog (DiffDialog.tsx)
 */
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  MouseEvent,
  ReactNode,
  TextareaHTMLAttributes
} from "react";
import { useState } from "react";
import { Ban, Check, ChevronDown, ChevronRight, CircleAlert, CircleDashed, CircleX, Info, LoaderCircle, Minus, MoreHorizontal, Plus, TriangleAlert, X, type LucideIcon } from "lucide-react";
import { Popover } from "@base-ui/react/popover";
import { Select as BaseSelect } from "@base-ui/react/select";
import { Tooltip } from "@base-ui/react/tooltip";
import { Button as ShellButton } from "../../chat-shell/Button.js";
import { cn } from "../lib/cn.js";
import { t } from "../../../i18n/index.js";
export { ConfigurationSelect, ConfigurationButton } from "../../chat-shell/composer/ConfigurationControl.js";
export { SourceEditor } from "./SourceEditor.js";
export { MarkdownPreview } from "./MarkdownPreview.js";

// ---- Buttons ----

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "accent" | "secondary" | "ghost";
  size?: "sm" | "md";
  outlined?: boolean;
};

/** Thin wrapper over the session shell's button so both layers render identical controls. */
export const Button = ({ variant = "secondary", size = "md", outlined, className, ...rest }: ButtonProps) => (
  <ShellButton variant={variant} size={size} className={cn(outlined && "vm-button-outlined", className)} {...rest} />
);

type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  icon: LucideIcon;
  /** Accessible name; also used as the tooltip. */
  label: string;
  size?: number;
  active?: boolean;
};

/** Square icon-only control for headers and rows. Always carries a name for screen readers and hover. */
export const IconButton = ({ icon: Icon, label, size = 14, active, className, ...rest }: IconButtonProps) => (
  <button
    type="button"
    aria-label={label}
    title={label}
    aria-pressed={active}
    className={cn(
      "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-hover hover:text-strong disabled:opacity-50 disabled:hover:bg-transparent",
      active && "bg-surface-selected text-strong",
      className
    )}
    {...rest}
  >
    <Icon size={size} />
  </button>
);

// ---- Text ----

/** Short label or risk level. Object states use `StatusPill`. */
export const Badge = ({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "accent" }) => (
  <span
    className={cn(
      "inline-flex shrink-0 items-center whitespace-nowrap min-h-5 rounded-sm border px-1.5 py-0.5 font-sans text-micro font-medium",
      tone === "neutral" && "border-border-strong text-foreground",
      tone === "accent" && "border-control-border-hover bg-accent-soft text-strong"
    )}
  >
    {children}
  </span>
);

/** The five state colours plus neutral, shared by pills, step dots and progress segments. */
export type StatusTone = "running" | "done" | "failed" | "attention" | "waiting" | "info" | "neutral";

const statusIcons: Record<StatusTone, LucideIcon> = {
  running: LoaderCircle, done: Check, failed: X, attention: CircleAlert, waiting: CircleDashed, info: Info, neutral: Ban
};

/** Object state: state icon + short text on the state colour's light fill. `icon` overrides the tone's default. */
export const StatusPill = ({ tone, icon, children }: { tone: StatusTone; icon?: LucideIcon; children: ReactNode }) => {
  const Icon = icon ?? statusIcons[tone];
  return (
    <span className="vm-pill" data-tone={tone === "waiting" ? "neutral" : tone}>
      <Icon size={12} aria-hidden="true" className={cn(tone === "running" && !icon && "vm-spin")} />
      <span>{children}</span>
    </span>
  );
};

/** 18px row-leading state marker for list rows and checklists: spinner while running, check when done, cross on failure. */
export const StatusIcon = ({ tone, label, icon }: { tone: StatusTone; label: string; icon?: LucideIcon }) => {
  const Icon = icon ?? statusIcons[tone];
  return (
    <span className="vm-state-icon" data-tone={tone} role="img" aria-label={label} title={label}>
      <Icon size={12} aria-hidden="true" className={cn(tone === "running" && !icon && "vm-spin")} />
    </span>
  );
};

/** Count that doubles as a filter toggle, e.g. the page header's "1 需要处理". Zero counts read neutral. */
export const FilterChip = ({ tone, count, label, pressed, onToggle }: { tone: StatusTone; count: number; label: string; pressed: boolean; onToggle: () => void }) => (
  <button type="button" className="vm-count-chip" data-tone={count ? tone : "neutral"} aria-pressed={pressed} onClick={onToggle}>{count} {label}</button>
);

/** Counted progress as a segmented bar plus the numbers, e.g. "0 / 1 已合入". */
export const Progress = ({ segments, label }: { segments: Array<"done" | "running" | "failed" | "pending">; label: ReactNode }) => (
  <span className="vm-progress">
    <span className="vm-progress__bar" role="presentation">
      {segments.map((tone, index) => <i key={index} data-tone={tone} />)}
    </span>
    <span>{label}</span>
  </span>
);

export type Step = { label: string; time?: string; state: "done" | "current" | "pending"; tone?: "running" | "attention" | "failed"; note?: ReactNode };

/** Fixed lifecycle stages: passed stages carry their time, the current one stands out and may carry the wait reason. */
export const Steps = ({ steps, label }: { steps: Step[]; label: string }) => (
  <ol className="vm-steps" aria-label={label}>
    {steps.map((step) => (
      <li key={step.label} className="vm-step" data-state={step.state} data-tone={step.tone} aria-current={step.state === "current" ? "step" : undefined}>
        <span className="vm-step__dot" aria-hidden="true" />
        <span className="vm-step__label">{step.label}</span>
        {step.time && <span className="vm-step__time">{step.time}</span>}
        {step.note && <span className="vm-step__note">{step.note}</span>}
      </li>
    ))}
  </ol>
);

/** Short label that heads a panel section. */
export const SectionLabel = ({ children, className }: { children: ReactNode; className?: string }) => (
  <div className={cn("eyebrow px-4 pb-1.5 pt-3", className)}>{children}</div>
);

/** One-line explanation or error under a header. `tone="error"` brightens it; errors stay text-only, never red. */
export const InlineNotice = ({ children, tone = "muted", className }: { children: ReactNode; tone?: "muted" | "error"; className?: string }) => (
  <p role={tone === "error" ? "alert" : undefined} className={cn("px-4 pb-2 text-caption", tone === "error" ? "text-strong" : "text-muted-foreground", className)}>
    {children}
  </p>
);

/** Something the user must act on: why it happened, what to do next, and the actions and details for it. */
export const Alert = ({ tone = "attention", title, next, actions, children }: {
  tone?: "attention" | "error";
  title: ReactNode;
  next?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) => {
  const Icon = tone === "error" ? CircleX : TriangleAlert;
  return (
    <div role="alert" className="vm-alert" data-tone={tone}>
      <Icon size={14} className="vm-alert__icon" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="vm-alert__title">{title}</p>
        {next && <p className="vm-alert__next">{next}</p>}
        {children}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
};

/**
 * Session activity marker, coloured like the session tree nodes: `running` pulses in yellow, `unread_completed`
 * stays solid green, `none` stays dark. The slot keeps its width either way so rows stay aligned.
 */
export const StatusDot = ({ status }: { status: "none" | "running" | "unread_completed" }) => (
  <span data-session-status={status} className="inline-flex h-1.5 w-1.5 shrink-0 items-center justify-center">
    {status !== "none" && (
      <span
        aria-label={status === "running" ? t("app.ui.running") : t("app.ui.completedUnread")}
        className={cn("h-1.5 w-1.5 rounded-full", status === "running" ? "animate-pulse bg-status-running" : "bg-status-unread")}
      />
    )}
  </span>
);

// ---- Fields ----

export const fieldClass =
  "w-full rounded-lg border border-control-border bg-input px-3 text-body text-foreground outline-none placeholder:text-faint-foreground focus:border-control-border-hover disabled:opacity-60";

type FieldBase = { label?: ReactNode; hint?: ReactNode; className?: string; compact?: boolean };
type FieldProps =
  | (FieldBase & { kind?: "input" } & InputHTMLAttributes<HTMLInputElement>)
  | (FieldBase & { kind: "textarea" } & TextareaHTMLAttributes<HTMLTextAreaElement>);

/** Labelled form control. The label is an eyebrow above; the hint sits below in caption text. */
export const Field = (props: FieldProps) => {
  const { label, hint, className } = props;
  const controlClass = cn(fieldClass, label && "mt-1.5", props.compact && "vm-field-compact");
  const control =
    props.kind === "textarea" ? (
      <textarea spellCheck={false} {...omit(props)} className={cn(controlClass, "resize-none py-2")} />
    ) : (
      <input spellCheck={false} {...omit(props)} className={cn(controlClass, "h-8")} />
    );
  return (
    <label className={cn("block", className)}>
      {label && <span className="eyebrow">{label}</span>}
      {control}
      {hint && <span className="mt-1 block text-caption text-muted-foreground">{hint}</span>}
    </label>
  );
};

// Strips the wrapper-only props so the rest can spread onto the native control.
const omit = <T extends FieldBase & { kind?: string }>(props: T): Omit<T, keyof FieldBase | "kind"> => {
  const { label: _label, hint: _hint, className: _className, compact: _compact, kind: _kind, ...rest } = props;
  return rest;
};

export type SelectOption = { value: string; label: string; hint?: string; disabled?: boolean };

/**
 * Single-choice dropdown drawn by the app (never the native <select>): trigger, popup list with optional
 * second-line hints, keyboard navigation. `plain` is the transparent, hairline-bordered trigger used in toolbars.
 * While the popup is open, options keep the order they had when it opened; reordering applies after it closes.
 */
export const Select = ({ value, options, onChange, label, hint, placeholder, disabled, compact, plain, className, "aria-label": ariaLabel }: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  label?: ReactNode;
  hint?: ReactNode;
  placeholder?: string;
  disabled?: boolean;
  compact?: boolean;
  plain?: boolean;
  className?: string;
  "aria-label"?: string;
}) => {
  const selected = options.find((option) => option.value === value);
  const [openOrder, setOpenOrder] = useState<string[]>();
  const shown = openOrder
    ? [...openOrder.flatMap((key) => options.find((option) => option.value === key) ?? []), ...options.filter((option) => !openOrder.includes(option.value))]
    : options;
  return (
    <div className={cn("block min-w-0", className)}>
      {label && <span className="eyebrow block">{label}</span>}
      <BaseSelect.Root value={selected ? value : null} disabled={disabled}
        onOpenChange={(open) => setOpenOrder(open ? options.map((option) => option.value) : undefined)}
        onValueChange={(next) => { if (typeof next === "string" && next !== value) onChange(next); }}>
        <BaseSelect.Trigger aria-label={ariaLabel ?? (typeof label === "string" ? label : undefined)}
          className={cn("vm-select-trigger", label && "mt-1.5")} data-compact={compact || undefined} data-plain={plain || undefined}>
          <span className="vm-select-value" data-placeholder={selected ? undefined : ""}>{selected?.label ?? placeholder ?? t("app.ui.selectPlaceholder")}</span>
          <ChevronDown size={14} aria-hidden="true" className="shrink-0 text-muted-foreground" />
        </BaseSelect.Trigger>
        <BaseSelect.Portal>
          <BaseSelect.Positioner side="bottom" align="start" sideOffset={4} alignItemWithTrigger={false} className="z-[1100]">
            <BaseSelect.Popup className="vm-select-popup">
              <BaseSelect.List>
                {shown.map((option) => (
                  <BaseSelect.Item key={option.value} value={option.value} label={option.label} disabled={option.disabled} className="vm-select-item">
                    <BaseSelect.ItemIndicator className="flex items-center text-strong" keepMounted={false}><Check size={13} aria-hidden="true" /></BaseSelect.ItemIndicator>
                    <BaseSelect.ItemText className="vm-select-item__text col-start-2">{option.label}</BaseSelect.ItemText>
                    {option.hint && <span className="vm-select-item__hint">{option.hint}</span>}
                  </BaseSelect.Item>
                ))}
              </BaseSelect.List>
            </BaseSelect.Popup>
          </BaseSelect.Positioner>
        </BaseSelect.Portal>
      </BaseSelect.Root>
      {hint && <span className="mt-1 block text-caption text-muted-foreground">{hint}</span>}
    </div>
  );
};

/** Switches between views of one list, e.g. 进行中 / 已结束 / 全部, each with an optional count. */
export const SegmentedControl = ({ items, value, onChange, label }: {
  items: Array<{ value: string; label: string; count?: number }>;
  value: string;
  onChange: (value: string) => void;
  label: string;
}) => (
  <div role="radiogroup" aria-label={label} className="vm-segmented"
    onKeyDown={(event) => {
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
      const index = items.findIndex((item) => item.value === value);
      const nextIndex = (index + (event.key === "ArrowRight" ? 1 : items.length - 1)) % items.length;
      const next = items[nextIndex];
      if (!next) return;
      event.preventDefault();
      onChange(next.value);
      (event.currentTarget.children[nextIndex] as HTMLElement | undefined)?.focus();
    }}>
    {items.map((item) => (
      <button key={item.value} type="button" role="radio" aria-checked={item.value === value}
        tabIndex={item.value === value ? 0 : -1} onClick={() => onChange(item.value)}>
        {item.label}{item.count !== undefined && <span className="vm-segmented-count">{item.count}</span>}
      </button>
    ))}
  </div>
);

// ---- Structure ----

/** Floating list surface shared by the status bar panel and hover cards. */
const floatingPanelClass = "flex max-h-[60vh] w-96 max-w-[94vw] flex-col overflow-auto rounded-md border border-border-strong bg-surface-raised py-1 floating-shadow";

export type OverflowMenuItem = { label: string; onSelect: () => void; disabled?: boolean };

/** Compact menu for card-level actions that should not occupy the primary action row. */
export const OverflowMenu = ({ label, items }: { label: string; items: OverflowMenuItem[] }) => {
  const [open, setOpen] = useState(false);
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger render={<IconButton icon={MoreHorizontal} label={label} />} />
    <Popover.Portal>
      <Popover.Positioner side="bottom" align="end" sideOffset={4} className="z-50">
        <Popover.Popup className={floatingPanelClass + " w-auto min-w-44"}>
          <ul role="menu">
            {items.map((item) => <li key={item.label}>
              <button type="button" role="menuitem" disabled={item.disabled} className="block w-full px-3 py-1.5 text-left text-label text-foreground hover:bg-surface-hover hover:text-strong disabled:text-faint-foreground" onClick={() => { setOpen(false); item.onSelect(); }}>
                {item.label}
              </button>
            </li>)}
          </ul>
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>;
};

/** Window-wide status feedback with an anchored, keyboard-accessible summary panel. */
export const StatusBar = ({ icon: Icon, label, notice, children, open, onOpenChange, trailing }: {
  icon: LucideIcon;
  label: string;
  notice?: string;
  children: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Right-aligned status items such as the output summary. */
  trailing?: ReactNode;
}) => (
  <footer aria-label={t("app.ui.statusBar")} className="flex h-8 shrink-0 items-center gap-1 border-t border-border-strong bg-app-shell px-2">
    <div role="status" className="min-w-0 max-w-full truncate text-caption text-foreground" title={notice}>
      {notice ?? (
        <Popover.Root open={open} onOpenChange={onOpenChange}>
          <Popover.Trigger render={<Button variant="ghost" size="sm" />}><Icon size={13} aria-hidden="true" />{label}</Popover.Trigger>
          <Popover.Portal>
            <Popover.Positioner side="top" align="start" sideOffset={6} className="z-50">
              <Popover.Popup aria-label={t("app.status.title")} className={floatingPanelClass}>
                {children}
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      )}
    </div>
    {trailing && <div className="ml-auto flex min-w-0 items-center gap-1">{trailing}</div>}
  </footer>
);

/** On/off switch. `labelHidden` keeps the name for assistive tech when a surrounding `SettingRow` already shows it. */
export const Toggle = ({ label, checked, disabled, labelHidden, onChange }: { label: string; checked: boolean; disabled?: boolean; labelHidden?: boolean; onChange: (checked: boolean) => void }) => (
  <button type="button" role="switch" aria-label={label} aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)} className="vm-toggle">
    <span className="vm-toggle-track" aria-hidden="true"><span /></span>{!labelHidden && label}
  </button>
);

/** One setting per row: name with its current state underneath on the left, extra actions and the control on the right. */
export const SettingRow = ({ label, state, actions, control }: { label: ReactNode; state?: ReactNode; actions?: ReactNode; control?: ReactNode }) => (
  <div className="vm-setting-row">
    <div className="vm-setting-row__text">
      <span className="vm-setting-row__label">{label}</span>
      {state && <span className="vm-setting-row__state">{state}</span>}
    </div>
    {actions && <div className="vm-setting-row__actions">{actions}</div>}
    {control}
  </div>
);

/** Multi-select control; `indeterminate` marks a parent whose children are only partly selected. */
export const Checkbox = ({ label, checked, indeterminate, disabled, onChange }: {
  label: string; checked: boolean; indeterminate?: boolean; disabled?: boolean; onChange: (checked: boolean) => void;
}) => (
  <label className="vm-checkbox">
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      aria-label={label}
      ref={(node) => { if (node) node.indeterminate = Boolean(indeterminate); }}
      onChange={(event) => onChange(event.target.checked)}
    />
    <span>{label}</span>
  </label>
);

export const Stepper = ({ label, value, min, max, disabled, onChange }: { label: string; value: number; min: number; max: number; disabled?: boolean; onChange: (value: number) => void }) => (
  <span className="vm-stepper">
    {label}<span className="vm-stepper-control">
      <IconButton icon={Minus} label={t("app.ui.decrease", { label })} disabled={disabled || value <= min} onClick={() => onChange(value - 1)} />
      <output aria-label={label}>{value}</output>
      <IconButton icon={Plus} label={t("app.ui.increase", { label })} disabled={disabled || value >= max} onClick={() => onChange(value + 1)} />
    </span>
  </span>
);

/** Page tabs. `count` marks items that need the user; zero is not shown. `children` sits at the bar's right end. */
export const Tabs = ({ items, selected, onSelect, children }: { items: Array<{ id: string; label: string; count?: number }>; selected: string; onSelect: (id: string) => void; children?: ReactNode }) => (
  <nav className="vm-tabs" aria-label={t("app.ui.tabs")}>
    {items.map((item) => <button key={item.id} type="button" aria-current={selected === item.id ? "page" : undefined} onClick={() => onSelect(item.id)}>
      {item.label}{item.count ? <span className="vm-tab-count" aria-label={t("app.ui.tabAttention", { count: item.count })}>{item.count}</span> : null}
    </button>)}
    {children && <div className="vm-tabs__end">{children}</div>}
  </nav>
);

/** Material groups inside one object (a panel or dialog): underlined tabs whose counts say what is inside. */
export const TabList = <T extends string>({ label, items, selected, onSelect }: {
  label: string; items: Array<{ id: T; label: string; count?: string }>; selected: T; onSelect: (id: T) => void;
}) => (
  <div role="tablist" aria-label={label} className="vm-tablist"
    onKeyDown={(event) => {
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
      const index = items.findIndex((item) => item.id === selected);
      const nextIndex = (index + (event.key === "ArrowRight" ? 1 : items.length - 1)) % items.length;
      event.preventDefault();
      onSelect(items[nextIndex]!.id);
      (event.currentTarget.children[nextIndex] as HTMLElement | undefined)?.focus();
    }}>
    {items.map((item) => <button key={item.id} type="button" role="tab" aria-selected={item.id === selected} tabIndex={item.id === selected ? 0 : -1} onClick={() => onSelect(item.id)}>
      {item.label}{item.count && <span className="vm-tablist__count">{item.count}</span>}
    </button>)}
  </div>
);

/**
 * Read-only detail that floats beside `children` while the pointer rests on them (or they hold focus).
 * The trigger is a plain block wrapper, so the decorated layout never changes.
 */
export const HoverCard = ({ children, content }: { children: ReactNode; content: ReactNode }) => (
  <Tooltip.Root>
    <Tooltip.Trigger render={<div />} delay={200}>{children}</Tooltip.Trigger>
    <Tooltip.Portal>
      <Tooltip.Positioner side="right" align="start" sideOffset={4} className="z-50">
        <Tooltip.Popup className={floatingPanelClass}>
          {content}
        </Tooltip.Popup>
      </Tooltip.Positioner>
    </Tooltip.Portal>
  </Tooltip.Root>
);

/** Page body header: title, overview counts (which may act as filters), then page settings and the one primary action. */
export const PageHeader = ({ title, summary, actions }: { title: ReactNode; summary?: ReactNode; actions?: ReactNode }) => (
  <header className="vm-page-header">
    <h2 className="vm-page-header__title">{title}</h2>
    {summary && <div className="vm-page-header__summary">{summary}</div>}
    {actions && <div className="vm-page-header__actions">{actions}</div>}
  </header>
);

/** Panel top line: section label plus optional actions, pushed right unless `align="start"` keeps them adjacent. */
export const PanelHeader = ({ title, children, className, align = "end" }: { title: ReactNode; children?: ReactNode; className?: string; align?: "end" | "start" }) => (
  <div className={cn("flex items-center pr-2", className)}>
    <SectionLabel>{title}</SectionLabel>
    {children && <div className={cn("flex items-center gap-1", align === "end" && "ml-auto")}>{children}</div>}
  </div>
);

type ListRowProps = {
  /** Icon, marker or badge before the title. */
  leading?: ReactNode;
  /** Independent control before the row's main click target. */
  leadingAction?: ReactNode;
  title: ReactNode;
  /** Second line under the title (path, timestamp, note). */
  meta?: ReactNode;
  /** Right-aligned status, time or actions. Stays visible; use `hoverActions` for controls that appear on hover. */
  trailing?: ReactNode;
  hoverActions?: ReactNode;
  selected?: boolean;
  /** Left indent in levels of 14px, for nested rows. */
  depth?: number;
  onClick?: () => void;
  onContextMenu?: (event: MouseEvent) => void;
  className?: string;
  titleClassName?: string;
  /** Dense one-line list with fixed status, hover-action and action slots. */
  columns?: { info?: ReactNode; status: ReactNode; action?: ReactNode; hoverAction?: ReactNode; control?: ReactNode; controls?: boolean };
  /**
   * Standard 44px object row (work items, roles): state icon | tag | title | stage | time | hover controls.
   * Controls sit in fixed slots that stay in place when hidden; `muted` dims ended objects, `compact` is the 40px variant.
   */
  cells?: { state: ReactNode; tag?: ReactNode; stage?: ReactNode; time?: ReactNode; timeTitle?: string; controls?: ReactNode[]; muted?: boolean; compact?: boolean; id?: string };
  expanded?: boolean;
};

/**
 * Standard row for sidebars and lists: leading | title / meta | trailing. Clickable when `onClick` is given;
 * the selection bar on the left is the same everywhere.
 */
export const ListRow = ({ leading, leadingAction, title, meta, trailing, hoverActions, selected, depth = 0, onClick, onContextMenu, className, titleClassName, columns, cells, expanded }: ListRowProps) => {
  if (cells) return (
    <div className={cn("vm-row-cells", className)} data-compact={cells.compact || undefined} data-muted={cells.muted || undefined} data-row-id={cells.id} style={depth ? { paddingLeft: 16 + depth * 28 } : undefined}>
      <span className="vm-row-cells__state">{cells.state}</span>
      <span className="vm-row-cells__tag">{cells.tag}</span>
      {onClick ? <button type="button" className="vm-row-cells__title" title={typeof title === "string" ? title : undefined} aria-expanded={expanded} onClick={onClick}>{title}</button>
        : <span className="vm-row-cells__title">{title}</span>}
      <span className="vm-row-cells__stage" title={typeof cells.stage === "string" ? cells.stage : undefined}>{cells.stage}</span>
      <span className="vm-row-cells__time" title={cells.timeTitle}>{cells.time}</span>
      <span className="vm-row-cells__controls">{(cells.controls ?? []).map((control, index) => <span key={index} className="vm-row-cells__slot">{control}</span>)}</span>
    </div>
  );
  if (columns) return (
    <div className={cn("vm-list-columns", columns.controls && "vm-list-columns-controls", className)} style={{ paddingLeft: 12 + depth * 14 }}>
      <span className="vm-list-leading">{leading}</span>
      <div className="vm-list-main min-w-0 py-1">
        {onClick ? <button type="button" aria-expanded={expanded} onClick={onClick} className={cn("block w-full truncate text-left text-label font-medium text-foreground hover:underline", titleClassName)}>{title}</button>
          : <span className={cn("block truncate text-label font-medium text-foreground", titleClassName)}>{title}</span>}
        {meta && <div className="text-caption text-muted-foreground">{meta}</div>}
      </div>
      <span className="vm-list-info">{columns.info}</span>
      <span className="vm-list-status">{columns.status}</span>
      {columns.controls && <span className="vm-list-control">{columns.control}</span>}
      <span className="vm-list-cancel">{columns.hoverAction}</span>
      <span className="vm-list-action">{columns.action}</span>
    </div>
  );
  const body = (
    <>
      <span className="flex min-w-0 items-center gap-2">
        {leading}
        <span className={cn("truncate text-label font-medium text-strong", titleClassName)}>{title}</span>
        {trailing && !meta && <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-micro text-muted-foreground">{trailing}</span>}
      </span>
      {meta && (
        <span className="flex min-w-0 items-center gap-2 text-caption text-muted-foreground">
          <span className="truncate">{meta}</span>
          {trailing && <span className="ml-auto flex shrink-0 items-center gap-2">{trailing}</span>}
        </span>
      )}
    </>
  );
  const shared = cn(
    "relative flex w-full flex-col gap-0.5 py-2 pr-4 text-left",
    onClick && "hover:bg-surface-hover",
    selected && "bg-surface-selected before:absolute before:bottom-[5px] before:left-0 before:top-[5px] before:w-0.5 before:bg-accent",
    className
  );
  const indent = 16 + depth * 14;
  const style = { paddingLeft: indent + (leadingAction ? 28 : 0) };
  if (!hoverActions && !leadingAction) {
    return onClick ? (
      <button type="button" className={shared} style={style} onClick={onClick} onContextMenu={onContextMenu}>{body}</button>
    ) : (
      <div className={shared} style={style} onContextMenu={onContextMenu}>{body}</div>
    );
  }
  return (
    <div className="group relative flex items-center">
      <button type="button" className={cn(shared, "min-w-0 flex-1")} style={style} onClick={onClick} onContextMenu={onContextMenu}>{body}</button>
      {leadingAction && <span className="absolute" style={{ left: indent }}>{leadingAction}</span>}
      {hoverActions && <span className="mr-2 flex shrink-0 items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">{hoverActions}</span>}
    </div>
  );
};

/** Bordered container for one self-contained item. Header line + body + optional footer actions. */
export const Card = ({ header, children, footer, className, compact, rows }: { header?: ReactNode; children?: ReactNode; footer?: ReactNode; className?: string; compact?: boolean; rows?: ReactNode }) => (
  <article className={cn("rounded-lg border border-border-strong bg-surface", compact && "vm-card-compact", className)}>
    {header && <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">{header}</header>}
    {children && <div className={compact ? "px-3 pb-2.5" : "px-4 py-3"}>{children}</div>}
    {rows && <div className="border-t border-border">{rows}</div>}
    {footer && <footer className="flex items-center gap-2 border-t border-border px-4 py-2.5">{footer}</footer>}
  </article>
);

/** Controlled card with an overview, adjacent metadata and inline detail. */
export const DisclosureCard = ({ title, open, onToggle, status, progress, time, actions, summary, children, plain = false }: {
  title: string; open: boolean; onToggle: () => void; status?: ReactNode; progress?: ReactNode;
  time?: ReactNode; actions?: ReactNode; summary?: ReactNode; children: ReactNode; plain?: boolean;
}) => (
  <article className={cn("vm-disclosure-card", plain && "vm-disclosure-plain")}>
    <header className="vm-disclosure-header">
      <Button variant="ghost" className="vm-disclosure-title" title={title} aria-expanded={open} onClick={onToggle}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<span>{title}</span>
      </Button>
      <span className="vm-disclosure-status">{status}</span>
      <span className="vm-disclosure-progress">{progress}</span>
      <span className="vm-disclosure-time">{time}</span>
      {actions}
      {summary && <div className="vm-disclosure-summary">{summary}</div>}
    </header>
    {open && <div className="vm-disclosure-body">{children}</div>}
  </article>
);

/** Readable section for contracts, results and other multiline detail content. */
export const DetailSection = ({ title, children }: { title: string; children: ReactNode }) => (
  <section>
    <SectionLabel className="px-0">{title}</SectionLabel>
    <div className="whitespace-pre-wrap break-words text-label text-foreground">{children}</div>
  </section>
);

/** Controlled disclosure for supplementary technical text; parents retain expansion across panel changes. */
export const CollapsibleDetails = ({ title = t("app.technicalDetails"), open, onToggle, children }: { title?: string; open: boolean; onToggle: () => void; children: string }) => (
  <div className="mt-3">
    <Button type="button" variant="ghost" size="sm" aria-expanded={open} onClick={onToggle}>
      {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}{title}
    </Button>
    {open && <pre className="mt-1.5 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-input px-3 py-2 font-mono text-caption leading-relaxed text-muted-foreground">{children}</pre>}
  </div>
);

/** Current state, why, and (optionally) the one thing to do next. One per view; never stack several. */
export const EmptyState = ({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) => (
  <div className="flex flex-col items-center justify-center gap-1 px-6 py-14 text-center">
    <p className="text-body text-foreground">{title}</p>
    {hint && <p className="max-w-sm text-caption text-muted-foreground">{hint}</p>}
    {action && <div className="mt-3">{action}</div>}
  </div>
);
