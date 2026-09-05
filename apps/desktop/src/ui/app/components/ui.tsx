import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Button as ShellButton } from "../../chat-shell/Button.js";
import { cn } from "../lib/cn.js";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "accent" | "secondary" | "ghost";
  size?: "sm" | "md";
};

/** Thin wrapper over the session shell's button so both layers render identical controls. */
export const Button = ({ variant = "secondary", size = "md", ...rest }: ButtonProps) => (
  <ShellButton variant={variant} size={size} {...rest} />
);

export const Badge = ({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "accent" }) => (
  <span
    className={cn(
      "inline-flex items-center rounded-sm border px-1.5 py-0.5 font-mono text-micro uppercase tracking-[0.12em]",
      tone === "neutral" && "border-border-strong text-muted-foreground",
      tone === "accent" && "border-control-border-hover bg-accent-soft text-strong"
    )}
  >
    {children}
  </span>
);

export const Empty = ({ title, hint }: { title: string; hint?: string }) => (
  <div className="flex flex-col items-center justify-center gap-1 px-6 py-14 text-center">
    <p className="text-body text-foreground">{title}</p>
    {hint && <p className="max-w-sm text-caption text-muted-foreground">{hint}</p>}
  </div>
);

export const SectionLabel = ({ children }: { children: ReactNode }) => (
  <div className="eyebrow px-4 pb-1.5 pt-3">{children}</div>
);
