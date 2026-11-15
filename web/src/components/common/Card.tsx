import React from "react";

export interface CardProps {
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
  hoverable?: boolean;
}

export function Card({
  children,
  className = "",
  onClick,
  hoverable = false,
}: CardProps) {
  return (
    <div
      onClick={onClick}
      className={`bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[var(--radius-lg)] p-4 shadow-sm transition-all ${
        hoverable
          ? "hover:border-[var(--border-strong)] hover:shadow-md cursor-pointer"
          : ""
      } ${className}`}
    >
      {children}
    </div>
  );
}
