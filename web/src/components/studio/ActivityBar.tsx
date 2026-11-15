import React from "react";
import {
  FolderKanban,
  MessagesSquare,
  ListTodo,
  Timer,
} from "lucide-react";
import { useStudio } from "../../context/StudioContext";
import type { StudioView } from "../../types";

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

  return (
    <aside className="w-[var(--activity-bar-width)] flex flex-col items-center py-2 bg-[var(--bg-activity-bar)] border-r border-[var(--border-default)] select-none z-20 shrink-0">
      {/* 4 VSCode-style Icon Buttons */}
      <nav className="flex flex-col items-center gap-1 w-full">
        {navItems.map((item) => {
          const isActive = activeView === item.view;
          return (
            <button
              key={item.view}
              onClick={() => setActiveView(item.view)}
              title={item.label}
              className={`relative w-9 h-9 rounded-[var(--radius-sm)] flex items-center justify-center transition-colors cursor-pointer ${
                isActive
                  ? "text-[var(--text-primary)] bg-[var(--bg-surface-elevated)] font-semibold"
                  : "text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)]"
              }`}
            >
              {/* VSCode Left Accent Pill */}
              {isActive && (
                <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-[var(--text-primary)] rounded-r" />
              )}
              {item.icon}
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
