import React from "react";
import { m } from "motion/react";
import {
  FolderKanban,
  MessagesSquare,
  ListTodo,
  Timer,
} from "lucide-react";
import { useStudio } from "../../context/StudioContext";
import type { StudioView } from "../../types";
import { SPRING_SNAPPY } from "../../utils/motion";

export function ActivityBar() {
  const { activeView, setActiveView } = useStudio();

  const navItems: { view: StudioView; label: string; icon: React.ReactNode }[] =
    [
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
      {/* 4 VSCode-style Icon Buttons with GPU-translated spring indicator */}
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
            <m.button
              key={item.view}
              type="button"
              whileTap={{ scale: 0.92 }}
              transition={{ duration: 0.1 }}
              onClick={() => setActiveView(item.view)}
              title={item.label}
              className={`relative w-9 h-9 rounded-[var(--radius-sm)] flex items-center justify-center transition-colors cursor-pointer ${
                isActive
                  ? "text-[var(--text-primary)] bg-[var(--bg-surface-elevated)] font-semibold"
                  : "text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)]"
              }`}
            >
              {item.icon}
            </m.button>
          );
        })}
      </nav>
    </aside>
  );
}
