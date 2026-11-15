import React from "react";
import { Bot, PanelRight, Plus, Sun, Moon, Monitor, Loader2, FolderGit2 } from "lucide-react";
import type { ProjectRouting } from "../types";
import type { ThemeMode } from "../hooks/useTheme";

interface HeaderProps {
  activeProject?: ProjectRouting | null;
  onNewSession: () => void;
  isCreatingSession?: boolean;
  showInspector: boolean;
  onToggleInspector: () => void;
  isReady: boolean;
  themeMode: ThemeMode;
  onCycleTheme: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  activeProject,
  onNewSession,
  isCreatingSession = false,
  showInspector,
  onToggleInspector,
  isReady,
  themeMode,
  onCycleTheme,
}) => {
  return (
    <header className="h-14 border-b border-[var(--border-default)] bg-[var(--bg-header)] backdrop-blur px-4 flex items-center justify-between z-10 shrink-0 select-none">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-[var(--primary-subtle)] border border-[var(--primary-border)] flex items-center justify-center text-[var(--primary-text)] shadow-xs">
          <Bot className="w-5 h-5" />
        </div>
        <div className="flex items-center gap-2">
          <div>
            <div className="flex items-center gap-2">
              <span className="font-semibold text-sm tracking-tight text-[var(--text-primary)]">
                Agent Orchestrator
              </span>
              <span
                className={`w-2 h-2 rounded-full ${
                  isReady ? "bg-emerald-500 animate-pulse" : "bg-[var(--text-muted)]"
                }`}
                title={isReady ? "Service Ready" : "Connecting..."}
              />
            </div>
            <p className="text-[11px] text-[var(--text-secondary)] font-mono">
              Codex / Multi-Repo Engine
            </p>
          </div>

          {activeProject && (
            <div className="hidden sm:flex items-center gap-1.5 ml-3 pl-3 border-l border-[var(--border-default)] text-xs">
              <FolderGit2 className="w-3.5 h-3.5 text-[var(--primary-text)]" />
              <span className="text-[var(--text-secondary)] font-medium">
                {activeProject.displayName || activeProject.projectId}
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2.5">
        {/* Theme Mode Toggle Button */}
        <button
          onClick={onCycleTheme}
          className="p-1.5 px-2.5 rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] hover:bg-[var(--bg-surface-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition cursor-pointer flex items-center gap-1.5 text-xs font-medium shadow-2xs"
          title={`主题模式: ${
            themeMode === "system" ? "跟随系统" : themeMode === "dark" ? "深色模式" : "浅色模式"
          } (点击切换)`}
        >
          {themeMode === "system" ? (
            <Monitor className="w-3.5 h-3.5 text-[var(--primary-text)]" />
          ) : themeMode === "dark" ? (
            <Moon className="w-3.5 h-3.5 text-indigo-400" />
          ) : (
            <Sun className="w-3.5 h-3.5 text-amber-500" />
          )}
          <span className="text-[11px] font-mono hidden md:inline">
            {themeMode === "system" ? "系统" : themeMode === "dark" ? "深色" : "浅色"}
          </span>
        </button>

        {/* New Session Button */}
        <button
          onClick={onNewSession}
          disabled={isCreatingSession}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--primary)] hover:bg-[var(--primary-hover)] disabled:opacity-60 disabled:hover:bg-[var(--primary)] disabled:cursor-not-allowed text-white text-xs font-medium transition shadow-sm shadow-indigo-600/20 cursor-pointer active:scale-95"
          title={
            activeProject
              ? `在项目 [${activeProject.displayName || activeProject.projectId}] 新建会话`
              : "新建会话"
          }
        >
          {isCreatingSession ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Plus className="w-3.5 h-3.5" />
          )}
          <span>{isCreatingSession ? "创建中..." : "新建会话"}</span>
        </button>

        {/* Toggle Inspector */}
        <button
          onClick={onToggleInspector}
          className={`p-1.5 rounded-lg border transition cursor-pointer ${
            showInspector
              ? "bg-[var(--bg-surface-elevated)] border-[var(--border-default)] text-[var(--primary-text)]"
              : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)]"
          }`}
          title="切换侧边调试面板"
        >
          <PanelRight className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
};
