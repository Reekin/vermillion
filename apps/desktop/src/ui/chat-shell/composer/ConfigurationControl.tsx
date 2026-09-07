import type { ButtonHTMLAttributes, SelectHTMLAttributes } from "react";

/** A configuration label and value form one focusable, unbroken control. */
export const ConfigurationSelect = ({ label, children, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { label: string }) => (
  <label className="awb-configuration-control">
    <span>{label}</span>
    <select {...props}>{children}</select>
  </label>
);

export const ConfigurationButton = ({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
  <button type="button" className={["awb-configuration-control", className].filter(Boolean).join(" ")} {...props} />
);
