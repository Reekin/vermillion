/**
 * Shared UI primitives for the application shell.
 *
 * Every panel is assembled from these; business components pass content and handlers,
 * primitives own layout, states and typography. See .vermillion/docs/Foundation/UIUX/Standards.md.
 *
 * Buttons       Button, IconButton
 * Text          Badge, SectionLabel, InlineNotice, StatusDot
 * Fields        Field (input / textarea / select / number)
 * Structure     PanelHeader, ListRow, Card, EmptyState, StatusBar
 * Overlays      Modal (Modal.tsx), ContextMenu (ContextMenu.tsx), DiffDialog (DiffDialog.tsx)
 */
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  MouseEvent,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes
} from "react";
import type { LucideIcon } from "lucide-react";
import { Popover } from "@base-ui/react/popover";
import { Button as ShellButton } from "../../chat-shell/Button.js";
import { cn } from "../lib/cn.js";

// ---- Buttons ----

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "accent" | "secondary" | "ghost";
  size?: "sm" | "md";
};

/** Thin wrapper over the session shell's button so both layers render identical controls. */
export const Button = ({ variant = "secondary", size = "md", ...rest }: ButtonProps) => (
  <ShellButton variant={variant} size={size} {...rest} />
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

export const Badge = ({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "accent" }) => (
  <span
    className={cn(
      "inline-flex shrink-0 items-center whitespace-nowrap rounded-sm border px-1.5 py-0.5 font-mono text-micro uppercase tracking-eyebrow",
      tone === "neutral" && "border-border-strong text-muted-foreground",
      tone === "accent" && "border-control-border-hover bg-accent-soft text-strong"
    )}
  >
    {children}
  </span>
);

/** Mono uppercase label that heads a panel section. */
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

type FieldBase = { label?: ReactNode; hint?: ReactNode; className?: string };
type FieldProps =
  | (FieldBase & { kind?: "input" } & InputHTMLAttributes<HTMLInputElement>)
  | (FieldBase & { kind: "textarea" } & TextareaHTMLAttributes<HTMLTextAreaElement>)
  | (FieldBase & { kind: "select"; children: ReactNode } & SelectHTMLAttributes<HTMLSelectElement>);

/** Labelled form control. The label is an eyebrow above; the hint sits below in caption text. */
export const Field = (props: FieldProps) => {
  const { label, hint, className } = props;
  const controlClass = cn(fieldClass, label && "mt-1.5");
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
  const { label: _label, hint: _hint, className: _className, kind: _kind, ...rest } = props;
  return rest;
};

// ---- Structure ----

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
              <Popover.Popup aria-label="当前任务" className="flex max-h-[60vh] w-96 max-w-[94vw] flex-col overflow-auto rounded-md border border-border-strong bg-surface-raised py-1 floating-shadow">
                {children}
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      )}
    </div>
  </footer>
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
};

/**
 * Standard row for sidebars and lists: leading | title / meta | trailing. Clickable when `onClick` is given;
 * the selection bar on the left is the same everywhere.
 */
export const ListRow = ({ leading, title, meta, trailing, hoverActions, selected, depth = 0, onClick, onContextMenu, className, titleClassName }: ListRowProps) => {
  const body = (
    <>
      <span className="flex min-w-0 items-center gap-2">
        {leading}
        <span className={cn("truncate text-label text-strong", titleClassName)}>{title}</span>
        {trailing && !meta && <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-micro text-faint-foreground">{trailing}</span>}
      </span>
      {meta && (
        <span className="flex min-w-0 items-center gap-2 font-mono text-micro text-faint-foreground">
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
      <span className="mr-2 hidden shrink-0 items-center gap-1 group-hover:flex">{hoverActions}</span>
    </div>
  );
};

/** Bordered container for one self-contained item (a decision, a mission, a review). Header line + body + optional footer actions. */
export const Card = ({ header, children, footer, className }: { header?: ReactNode; children: ReactNode; footer?: ReactNode; className?: string }) => (
  <article className={cn("rounded-lg border border-border-strong bg-surface", className)}>
    {header && <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">{header}</header>}
    <div className="px-4 py-3">{children}</div>
    {footer && <footer className="flex items-center gap-2 border-t border-border px-4 py-2.5">{footer}</footer>}
  </article>
);

/** Current state, why, and (optionally) the one thing to do next. One per view; never stack several. */
export const EmptyState = ({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) => (
  <div className="flex flex-col items-center justify-center gap-1 px-6 py-14 text-center">
    <p className="text-body text-foreground">{title}</p>
    {hint && <p className="max-w-sm text-caption text-muted-foreground">{hint}</p>}
    {action && <div className="mt-3">{action}</div>}
  </div>
);
