import React from "react";

export interface BadgeProps {
  children: React.ReactNode;
  variant?: "success" | "error" | "warning" | "info" | "pending" | "neutral";
  size?: "xs" | "sm" | "md";
  className?: string;
  dot?: boolean;
}

export function Badge({
  children,
  variant = "neutral",
  size = "sm",
  className = "",
  dot = false,
}: BadgeProps) {
  const variantStyles = {
    success: "bg-[var(--status-success-bg)] text-[var(--status-success-text)] border-[var(--status-success-border)]",
    error: "bg-[var(--status-error-bg)] text-[var(--status-error-text)] border-[var(--status-error-border)]",
    warning: "bg-[var(--status-warning-bg)] text-[var(--status-warning-text)] border-[var(--status-warning-border)]",
    info: "bg-[var(--status-info-bg)] text-[var(--status-info-text)] border-[var(--status-info-border)]",
    pending: "bg-[var(--status-pending-bg)] text-[var(--status-pending-text)] border-[var(--status-pending-border)]",
    neutral: "bg-[var(--status-neutral-bg)] text-[var(--status-neutral-text)] border-[var(--status-neutral-border)]",
  };

  const sizeStyles = {
    xs: "text-[10px] px-1.5 py-0.5",
    sm: "text-xs px-2 py-0.5",
    md: "text-xs px-2.5 py-1 font-medium",
  };

  const dotStyles = {
    success: "bg-[var(--status-success-text)]",
    error: "bg-[var(--status-error-text)]",
    warning: "bg-[var(--status-warning-text)]",
    info: "bg-[var(--status-info-text)]",
    pending: "bg-[var(--status-pending-text)]",
    neutral: "bg-[var(--status-neutral-text)]",
  };

  return (
    <span
      className={`inline-flex items-center gap-1.5 font-medium border rounded-[var(--radius-sm)] transition-colors ${variantStyles[variant]} ${sizeStyles[size]} ${className}`}
    >
      {dot && (
        <span
          className={`w-1.5 h-1.5 rounded-full animate-pulse ${dotStyles[variant]}`}
        />
      )}
      {children}
    </span>
  );
}
