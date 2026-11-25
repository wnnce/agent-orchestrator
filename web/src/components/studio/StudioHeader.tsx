import React, { useState, useRef, useEffect, useMemo } from "react";
import { AnimatePresence, m } from "motion/react";
import { generatePath, Link, useNavigate, useParams } from "react-router";
import {
  ChevronDown,
  PanelRightClose,
  PanelRightOpen,
  RotateCw,
  FolderKanban,
  Sun,
  Moon,
  Zap,
  Check,
} from "lucide-react";
import { useStudio } from "../../context/StudioContext";
import { useTheme } from "../../context/ThemeContext";
import { useCurrentRouteHandle } from "../../layouts/ProjectLayout";
import { ROUTES, viewPath } from "../../routes";
import type { ProjectRouting } from "../../types";
import { EASE_OUT_EXPO } from "../../utils/motion";

interface StudioHeaderProps {
  project: ProjectRouting;
}

export function StudioHeader({ project }: StudioHeaderProps) {
  const {
    projects,
    sessions,
    showInspector,
    toggleInspector,
    refreshProjects,
    refreshSessions,
    isReady,
  } = useStudio();
  const { sessionId } = useParams<{ sessionId?: string }>();
  const handle = useCurrentRouteHandle();
  const navigate = useNavigate();

  const { theme, cycleTheme } = useTheme();
  const [projectDropdownOpen, setProjectDropdownOpen] = useState(false);
  const [refreshSpinKey, setRefreshSpinKey] = useState(0);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const activeNav = handle?.nav ?? "sessions";
  const sectionTitle = handle?.title ?? "Sessions";

  const activeSession = useMemo(
    () => (sessionId ? sessions.find((s) => s.sessionId === sessionId) ?? null : null),
    [sessions, sessionId],
  );

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setProjectDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleRefresh = () => {
    setRefreshSpinKey((k) => k + 1);
    refreshProjects();
    refreshSessions(project.projectId);
  };

  const handleSelectProject = (nextProjectId: string) => {
    setProjectDropdownOpen(false);
    navigate(viewPath(nextProjectId, activeNav));
  };

  return (
    <header className="h-[var(--header-height)] px-3.5 flex items-center justify-between bg-[var(--bg-header)] border-b border-[var(--border-default)] shrink-0 z-30 select-none box-border">
      {/* Left: Vercel-style Logo & Project Selector Breadcrumbs */}
      <div className="flex items-center gap-2 h-7">
        {/* Vercel Geometric Triangle Logo */}
        <div className="flex items-center gap-2 h-7 pr-1">
          <svg
            className="w-3.5 h-3.5 fill-current text-[var(--text-primary)] shrink-0"
            viewBox="0 0 76 65"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path d="M37.5274 0L75.0548 65H0L37.5274 0Z" />
          </svg>
          <span className="font-semibold text-xs tracking-tight text-[var(--text-primary)] font-mono leading-none">
            STUDIO
          </span>
        </div>

        {/* Slash divider with strict vertical alignment */}
        <span className="text-[var(--border-strong)] text-xs font-mono select-none leading-none flex items-center">
          /
        </span>

        {/* Project Selector Dropdown */}
        <div className="relative flex items-center h-7" ref={dropdownRef}>
          <button
            type="button"
            onClick={() => setProjectDropdownOpen((prev) => !prev)}
            className="h-7 flex items-center gap-1.5 px-2 rounded-[var(--radius-sm)] text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)] transition-colors cursor-pointer border border-transparent hover:border-[var(--border-default)] leading-none"
          >
            <FolderKanban className="w-3.5 h-3.5 text-[var(--text-secondary)] shrink-0" />
            <span className="font-medium leading-none">
              {project.displayName || project.projectId}
            </span>
            <ChevronDown
              className={`w-3 h-3 text-[var(--text-muted)] shrink-0 transition-transform duration-150 ${
                projectDropdownOpen ? "rotate-180" : ""
              }`}
            />
          </button>

          {/* Minimalist Dropdown Menu */}
          <AnimatePresence>
            {projectDropdownOpen && (
              <m.div
                initial={{ opacity: 0, y: -4, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -4, scale: 0.98 }}
                transition={{ duration: 0.14, ease: EASE_OUT_EXPO }}
                className="absolute left-0 top-full mt-1 w-56 rounded-[var(--radius-md)] bg-[var(--bg-surface-elevated)] border border-[var(--border-default)] shadow-lg py-1 z-50 origin-top-left"
              >
                <div className="px-2.5 py-1 text-[10px] uppercase tracking-wider text-[var(--text-muted)] font-mono border-b border-[var(--border-subtle)] mb-1">
                  Projects
                </div>
                {projects.map((p) => {
                  const isSelected = p.projectId === project.projectId;
                  return (
                    <button
                      key={p.projectId}
                      type="button"
                      onClick={() => handleSelectProject(p.projectId)}
                      className={`w-full px-2.5 py-1.5 text-xs text-left flex items-center justify-between hover:bg-[var(--bg-surface-hover)] transition-colors cursor-pointer ${
                        isSelected
                          ? "text-[var(--text-primary)] font-semibold bg-[var(--bg-surface)]"
                          : "text-[var(--text-secondary)]"
                      }`}
                    >
                      <span className="truncate">{p.displayName || p.projectId}</span>
                      {isSelected && (
                        <Check className="w-3.5 h-3.5 text-[var(--text-primary)] shrink-0" />
                      )}
                    </button>
                  );
                })}
              </m.div>
            )}
          </AnimatePresence>
        </div>

        {/* View Section Indicator / Session Breadcrumb */}
        <span className="text-[var(--border-strong)] text-xs font-mono select-none leading-none flex items-center">
          /
        </span>

        {activeNav === "sessions" && sessionId ? (
          <div className="flex items-center gap-1.5 h-7 text-xs font-mono leading-none">
            <Link
              to={generatePath(ROUTES.sessions, { projectId: project.projectId })}
              className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors cursor-pointer leading-none"
            >
              Sessions
            </Link>
            <span className="text-[var(--border-strong)] text-xs font-mono select-none leading-none">
              /
            </span>
            <span
              className="font-medium text-[var(--text-primary)] leading-none max-w-[240px] truncate"
              title={
                activeSession?.title ? `${activeSession.title} (${sessionId})` : sessionId
              }
            >
              {activeSession?.title ||
                (sessionId.length > 20 ? `${sessionId.slice(0, 16)}...` : sessionId)}
            </span>
            {(activeSession?.status === "archived" || activeSession?.status === "closing") && (
              <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-normal text-[var(--text-muted)] bg-[var(--bg-surface-elevated)] border border-[var(--border-default)] leading-none shrink-0">
                {activeSession.status === "archived" ? "Archived" : "Closing"}
              </span>
            )}
          </div>
        ) : (
          <span className="text-xs text-[var(--text-secondary)] font-medium leading-none flex items-center h-7">
            {sectionTitle}
          </span>
        )}
      </div>

      {/* Right: Actions, Health Dot & Theme Switcher */}
      <div className="flex items-center gap-1.5 h-7">
        {/* System Health Dot */}
        <div
          title={isReady ? "Ready (Online)" : "Offline"}
          className="h-7 flex items-center gap-1.5 px-2 rounded-[var(--radius-sm)] text-xs text-[var(--text-muted)] leading-none"
        >
          <span
            className={`w-1.5 h-1.5 rounded-full shrink-0 ${
              isReady ? "bg-emerald-500" : "bg-red-500"
            }`}
          />
          <span className="text-[11px] font-mono hidden sm:inline leading-none">
            {isReady ? "Ready" : "Offline"}
          </span>
        </div>

        {/* Data Refresh button */}
        <m.button
          whileTap={{ scale: 0.9 }}
          onClick={handleRefresh}
          title="Refresh"
          className="w-7 h-7 flex items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)] transition-colors cursor-pointer"
        >
          <m.span
            key={refreshSpinKey}
            initial={refreshSpinKey > 0 ? { rotate: 0 } : false}
            animate={refreshSpinKey > 0 ? { rotate: 360 } : undefined}
            transition={{ duration: 0.45, ease: EASE_OUT_EXPO }}
            className="inline-flex"
          >
            <RotateCw className="w-3.5 h-3.5" />
          </m.span>
        </m.button>

        {/* Dark Mode / Theme Cycler in Header */}
        <button
          onClick={cycleTheme}
          title={`Theme: ${theme}`}
          className="w-7 h-7 flex items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)] transition-colors cursor-pointer"
        >
          {theme === "dark" && <Moon className="w-3.5 h-3.5" />}
          {theme === "light" && <Sun className="w-3.5 h-3.5 text-amber-500" />}
          {theme === "cyber" && <Zap className="w-3.5 h-3.5 text-cyan-400" />}
        </button>

        {/* Inspector toggle (Only in active conversation) */}
        {activeNav === "sessions" && sessionId && (
          <button
            onClick={toggleInspector}
            title={showInspector ? "Hide Inspector" : "Show Inspector"}
            className={`w-7 h-7 flex items-center justify-center rounded-[var(--radius-sm)] transition-colors cursor-pointer ${
              showInspector
                ? "bg-[var(--bg-surface-elevated)] text-[var(--text-primary)] border border-[var(--border-strong)]"
                : "text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)]"
            }`}
          >
            {showInspector ? (
              <PanelRightClose className="w-3.5 h-3.5" />
            ) : (
              <PanelRightOpen className="w-3.5 h-3.5" />
            )}
          </button>
        )}
      </div>
    </header>
  );
}
