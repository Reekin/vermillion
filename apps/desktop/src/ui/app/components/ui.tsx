import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/cn.js";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger"; size?: "sm" | "md" };

export const Button = ({ variant = "secondary", size = "md", className, ...rest }: ButtonProps) => (
  <button
    type="button"
    className={cn(
      "inline-flex items-center justify-center gap-1.5 rounded-md border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
      size === "sm" ? "h-7 px-2.5 text-caption" : "h-8 px-3 text-label",
      variant === "primary" && "border-transparent bg-brand text-brand-foreground hover:brightness-110",
      variant === "secondary" && "border-input bg-surface text-foreground hover:bg-surface-hover",
      variant === "ghost" && "border-transparent text-muted-foreground hover:bg-surface-hover hover:text-foreground",
      variant === "danger" && "border-transparent bg-destructive/15 text-destructive hover:bg-destructive/25",
      className
    )}
    {...rest}
  />
);

export const Badge = ({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "brand" | "success" | "warning" }) => (
  <span
    className={cn(
      "inline-flex items-center rounded-sm px-1.5 py-0.5 text-micro font-semibold uppercase tracking-wide",
      tone === "neutral" && "bg-muted text-muted-foreground",
      tone === "brand" && "bg-brand/15 text-brand",
      tone === "success" && "bg-success/15 text-success",
      tone === "warning" && "bg-warning/15 text-warning"
    )}
  >
    {children}
  </span>
);

export const Empty = ({ title, hint }: { title: string; hint?: string }) => (
  <div className="flex flex-col items-center justify-center gap-1 px-6 py-14 text-center">
    <p className="text-body font-medium text-foreground">{title}</p>
    {hint && <p className="max-w-sm text-caption text-muted-foreground">{hint}</p>}
  </div>
);

export const SectionLabel = ({ children }: { children: ReactNode }) => (
  <div className="px-3 pb-1 pt-3 text-micro font-semibold uppercase tracking-[0.14em] text-faint-foreground">{children}</div>
);
