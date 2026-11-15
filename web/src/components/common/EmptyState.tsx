import React from "react";
import { FolderOpen } from "lucide-react";

export interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({
  icon = <FolderOpen className="w-8 h-8 text-[var(--text-muted)]" />,
  title,
  description,
  action,
  className = "",
}: EmptyStateProps) {
  return (
    <div
      className={`flex flex-col items-center justify-center p-8 text-center rounded-[var(--radius-lg)] border border-dashed border-[var(--border-default)] bg-[var(--bg-subtle)] ${className}`}
    >
      <div className="mb-3 p-3 rounded-full bg-[var(--bg-surface)] border border-[var(--border-subtle)] shadow-xs">
        {icon}
      </div>
      <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-1">
        {title}
      </h3>
      {description && (
        <p className="text-xs text-[var(--text-muted)] max-w-sm mb-4">
          {description}
        </p>
      )}
      {action && <div>{action}</div>}
    </div>
  );
}
