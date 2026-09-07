/**
 * Shared UI primitives for the application shell.
 *
 * Every panel is assembled from these; business components pass content and handlers,
 * primitives own layout, states and typography. See .vermillion/docs/Foundation/UIUX/Standards.md.
 *
 * Buttons       Button, IconButton
 * Text          Badge, SectionLabel, InlineNotice, StatusDot
 * Fields        Field (input / textarea / select / number), Toggle, Stepper
 * Structure     PanelHeader, Tabs, ListRow, Card, CollapsibleDetails, EmptyState, StatusBar
 * Overlays      HoverCard, Modal (Modal.tsx), ContextMenu (ContextMenu.tsx), DiffDialog (DiffDialog.tsx)
 */
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  MouseEvent,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes
} from "react";
import { ChevronDown, ChevronRight, Minus, Plus, type LucideIcon } from "lucide-react";
import { Popover } from "@base-ui/react/popover";
import { Tooltip } from "@base-ui/react/tooltip";
import { Button as ShellButton } from "../../chat-shell/Button.js";
import { cn } from "../lib/cn.js";
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

export const Badge = ({ children, tone = "neutral", status, muted }: { children: ReactNode; tone?: "neutral" | "accent"; status?: "decision" | "running" | "queued" | "closed" | "cancelled"; muted?: boolean }) => (
  <span
    data-status={status}
    className={cn(
      status ? "vm-status" : "inline-flex shrink-0 items-center whitespace-nowrap min-h-5 rounded-sm border px-1.5 py-0.5 font-sans text-micro font-medium",
      !status && tone === "neutral" && "border-border-strong text-foreground",
      !status && tone === "accent" && "border-control-border-hover bg-accent-soft text-strong",
      muted && "vm-status-muted"
    )}
  >
    {status && status !== "closed" && status !== "cancelled" && <span className="vm-status-marker" aria-hidden="true" />}
    {children}
  </span>
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

/**
 * Session activity marker. `running`: a turn is in progress (pulses). `unread_completed`: a turn finished while
 * the session was not open (solid with halo); it clears once the session is opened. `none` renders nothing.
 */
export const StatusDot = ({ status }: { status: "none" | "running" | "unread_completed" }) => {
  if (status === "none") return null;
  return (
    <span
      aria-label={status === "running" ? "运行中" : "有新回复"}
      className={cn(
        "h-1.5 w-1.5 shrink-0 rounded-full bg-accent-strong",
        status === "running" ? "animate-pulse" : "shadow-halo"
      )}
    />
  );
};

// ---- Fields ----

export const fieldClass =
  "w-full rounded-lg border border-control-border bg-input px-3 text-body text-foreground outline-none placeholder:text-faint-foreground focus:border-control-border-hover disabled:opacity-60";

type FieldBase = { label?: ReactNode; hint?: ReactNode; className?: string; compact?: boolean };
type FieldProps =
  | (FieldBase & { kind?: "input" } & InputHTMLAttributes<HTMLInputElement>)
  | (FieldBase & { kind: "textarea" } & TextareaHTMLAttributes<HTMLTextAreaElement>)
  | (FieldBase & { kind: "select"; children: ReactNode } & SelectHTMLAttributes<HTMLSelectElement>);

/** Labelled form control. The label is an eyebrow above; the hint sits below in caption text. */
export const Field = (props: FieldProps) => {
  const { label, hint, className } = props;
  const controlClass = cn(fieldClass, label && "mt-1.5", props.compact && "vm-field-compact");
  const control =
    props.kind === "textarea" ? (
      <textarea spellCheck={false} {...omit(props)} className={cn(controlClass, "resize-none py-2")} />
    ) : props.kind === "select" ? (
      <select {...omit(props)} className={cn(controlClass, "h-8")} />
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

// ---- Structure ----

/** Floating list surface shared by the status bar panel and hover cards. */
const floatingPanelClass = "flex max-h-[60vh] w-96 max-w-[94vw] flex-col overflow-auto rounded-md border border-border-strong bg-surface-raised py-1 floating-shadow";

/** Window-wide status feedback with an anchored, keyboard-accessible summary panel. */
export const StatusBar = ({ icon: Icon, label, notice, children, open, onOpenChange }: {
  icon: LucideIcon;
  label: string;
  notice?: string;
  children: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => (
  <footer aria-label="状态条" className="flex h-8 shrink-0 items-center border-t border-border-strong bg-app-shell px-2">
    <div role="status" className="min-w-0 max-w-full truncate text-caption text-foreground" title={notice}>
      {notice ?? (
        <Popover.Root open={open} onOpenChange={onOpenChange}>
          <Popover.Trigger render={<Button variant="ghost" size="sm" />}><Icon size={13} aria-hidden="true" />{label}</Popover.Trigger>
          <Popover.Portal>
            <Popover.Positioner side="top" align="start" sideOffset={6} className="z-50">
              <Popover.Popup aria-label="当前任务" className={floatingPanelClass}>
                {children}
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      )}
    </div>
  </footer>
);

export const Toggle = ({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) => (
  <button type="button" role="switch" aria-label={label} aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)} className="vm-toggle">
    <span className="vm-toggle-track" aria-hidden="true"><span /></span>{label}
  </button>
);

export const Stepper = ({ label, value, min, max, disabled, onChange }: { label: string; value: number; min: number; max: number; disabled?: boolean; onChange: (value: number) => void }) => (
  <span className="vm-stepper">
    {label}<span className="vm-stepper-control">
      <IconButton icon={Minus} label={"减少" + label} disabled={disabled || value <= min} onClick={() => onChange(value - 1)} />
      <output aria-label={label}>{value}</output>
      <IconButton icon={Plus} label={"增加" + label} disabled={disabled || value >= max} onClick={() => onChange(value + 1)} />
    </span>
  </span>
);

export const Tabs = ({ items, selected, onSelect, children }: { items: Array<{ id: string; label: string; count?: number }>; selected: string; onSelect: (id: string) => void; children?: ReactNode }) => (
  <nav className="vm-tabs" aria-label="workspace 导航">
    {items.map((item) => <button key={item.id} type="button" aria-current={selected === item.id ? "page" : undefined} onClick={() => onSelect(item.id)}>
      {item.label}{item.count !== undefined && <span className="vm-tab-count">{item.count}</span>}
    </button>)}
    {children}
  </nav>
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

/** Panel top line: section label on the left, optional actions on the right. */
export const PanelHeader = ({ title, children, className }: { title: ReactNode; children?: ReactNode; className?: string }) => (
  <div className={cn("flex items-center pr-2", className)}>
    <SectionLabel>{title}</SectionLabel>
    {children && <div className="ml-auto flex items-center gap-1">{children}</div>}
  </div>
);

type ListRowProps = {
  /** Icon, marker or badge before the title. */
  leading?: ReactNode;
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
  columns?: { info?: ReactNode; status: ReactNode; action?: ReactNode; hoverAction?: ReactNode };
};

/**
 * Standard row for sidebars and lists: leading | title / meta | trailing. Clickable when `onClick` is given;
 * the selection bar on the left is the same everywhere.
 */
export const ListRow = ({ leading, title, meta, trailing, hoverActions, selected, depth = 0, onClick, onContextMenu, className, titleClassName, columns }: ListRowProps) => {
  if (columns) return (
    <div className={cn("vm-list-columns", className)}>
      {leading}
      {onClick ? <button type="button" onClick={onClick} className={cn("truncate text-left text-label font-medium text-foreground hover:underline", titleClassName)}>{title}</button>
        : <span className={cn("truncate text-label font-medium text-foreground", titleClassName)}>{title}</span>}
      <span className="vm-list-info">{columns.info}</span>
      <span className="vm-list-status">{columns.status}</span>
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
  const style = { paddingLeft: 16 + depth * 14 };
  if (!hoverActions) {
    return onClick ? (
      <button type="button" className={shared} style={style} onClick={onClick} onContextMenu={onContextMenu}>{body}</button>
    ) : (
      <div className={shared} style={style} onContextMenu={onContextMenu}>{body}</div>
    );
  }
  return (
    <div className="group flex items-center">
      <button type="button" className={cn(shared, "min-w-0 flex-1")} style={style} onClick={onClick} onContextMenu={onContextMenu}>{body}</button>
      <span className="mr-2 flex shrink-0 items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">{hoverActions}</span>
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

/** Readable section for contracts, results and other multiline detail content. */
export const DetailSection = ({ title, children }: { title: string; children: ReactNode }) => (
  <section>
    <SectionLabel className="px-0">{title}</SectionLabel>
    <div className="whitespace-pre-wrap break-words text-label text-foreground">{children}</div>
  </section>
);

/** Controlled disclosure for supplementary technical text; parents retain expansion across panel changes. */
export const CollapsibleDetails = ({ title = "技术详情", open, onToggle, children }: { title?: string; open: boolean; onToggle: () => void; children: string }) => (
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
