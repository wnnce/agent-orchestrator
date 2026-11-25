import React from "react";
import { m } from "motion/react";
import { NavLink } from "react-router";
import { FolderKanban, MessagesSquare, ListTodo, Timer } from "lucide-react";
import { useCurrentRouteHandle } from "../../layouts/ProjectLayout";
import { viewPath } from "../../routes";
import type { StudioView } from "../../types";
import { SPRING_SNAPPY } from "../../utils/motion";

interface ActivityBarProps {
  projectId: string;
}

export function ActivityBar({ projectId }: ActivityBarProps) {
  const handle = useCurrentRouteHandle();
  const activeView: StudioView = handle?.nav ?? "sessions";

  const navItems: { view: StudioView; label: string; icon: React.ReactNode }[] = [
    {
      view: "project",
      label: "Project Overview (项目信息)",
      icon: <FolderKanban className="w-4 h-4" />,
    },
    {
      view: "sessions",
      label: "Sessions & Flow (会话信息与对话)",
      icon: <MessagesSquare className="w-4 h-4" />,
    },
    {
      view: "tasks",
      label: "Tasks & Pipeline (任务与流水线)",
      icon: <ListTodo className="w-4 h-4" />,
    },
    {
      view: "jobs",
      label: "Scheduled Jobs (延时任务)",
      icon: <Timer className="w-4 h-4" />,
    },
  ];

  const activeIndex = Math.max(
    0,
    navItems.findIndex((item) => item.view === activeView),
  );

  return (
    <aside className="w-[var(--activity-bar-width)] flex flex-col items-center py-2 bg-[var(--bg-activity-bar)] border-r border-[var(--border-default)] select-none z-20 shrink-0">
      <nav className="relative flex flex-col items-center gap-1 w-full">
        <m.span
          aria-hidden
          animate={{ y: activeIndex * 40 }}
          transition={SPRING_SNAPPY}
          className="pointer-events-none absolute left-1.5 top-1.5 h-6 w-0.5 bg-[var(--text-primary)] rounded-r z-10"
        />
        {navItems.map((item) => {
          const isActive = activeView === item.view;
          return (
            <NavLink
              key={item.view}
              to={viewPath(projectId, item.view)}
              title={item.label}
              className={`relative w-9 h-9 rounded-[var(--radius-sm)] flex items-center justify-center transition-colors cursor-pointer active:scale-92 ${
                isActive
                  ? "text-[var(--text-primary)] bg-[var(--bg-surface-elevated)] font-semibold"
                  : "text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)]"
              }`}
            >
              {item.icon}
            </NavLink>
          );
        })}
      </nav>
    </aside>
  );
}
