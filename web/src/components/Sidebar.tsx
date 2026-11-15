import React, { useState, useMemo } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  MessageSquare,
  Clock,
  Trash2,
  Plus,
  Loader2,
  Search,
  ChevronsUpDown,
  Layers,
} from "lucide-react";
import type { ProjectRouting, SessionRoute } from "../types";

interface SidebarProps {
  projects: ProjectRouting[];
  sessions: SessionRoute[];
  activeSessionId: string | null;
  selectedProjectId: string | null;
  onSelectSession: (sessionId: string, projectId?: string) => void;
  onSelectProject?: (projectId: string) => void;
  onDeleteSession?: (sessionId: string) => void;
  deletingSessionId?: string | null;
  onNewSession?: (projectId?: string) => void;
  isCreatingSession?: boolean;
}

export const Sidebar: React.FC<SidebarProps> = ({
  projects,
  sessions,
  activeSessionId,
  selectedProjectId,
  onSelectSession,
  onSelectProject,
  onDeleteSession,
  deletingSessionId,
  onNewSession,
  isCreatingSession = false,
}) => {
  const [searchTerm, setSearchTerm] = useState("");
  // Track expanded state for projects; default is all expanded
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});

  // Group sessions by project ID
  const { groupedSessions, unassignedSessions } = useMemo(() => {
    const knownProjectIds = new Set(projects.map((p) => p.projectId));
    const groups = new Map<string, SessionRoute[]>();

    for (const p of projects) {
      groups.set(p.projectId, []);
    }

    const unassigned: SessionRoute[] = [];

    for (const session of sessions) {
      if (session.projectId && groups.has(session.projectId)) {
        groups.get(session.projectId)!.push(session);
      } else {
        unassigned.push(session);
      }
    }

    return {
      groupedSessions: groups,
      unassignedSessions: unassigned,
    };
  }, [projects, sessions]);

  // Filter projects and sessions by search term
  const filteredProjects = useMemo(() => {
    if (!searchTerm.trim()) return projects;
    const term = searchTerm.toLowerCase();

    return projects.filter((p) => {
      const matchProject =
        p.displayName?.toLowerCase().includes(term) ||
        p.projectId.toLowerCase().includes(term) ||
        p.summary?.toLowerCase().includes(term);

      const projectSessions = groupedSessions.get(p.projectId) || [];
      const matchSession = projectSessions.some(
        (s) =>
          s.sessionId.toLowerCase().includes(term) ||
          s.repositoryId?.toLowerCase().includes(term),
      );

      return matchProject || matchSession;
    });
  }, [projects, groupedSessions, searchTerm]);

  const isProjectExpanded = (projectId: string) => {
    // If searching, keep all expanded
    if (searchTerm.trim()) return true;
    return expandedProjects[projectId] !== false;
  };

  const toggleProject = (projectId: string) => {
    setExpandedProjects((prev) => ({
      ...prev,
      [projectId]: !isProjectExpanded(projectId),
    }));
  };

  const toggleAll = () => {
    const allExpanded = projects.every((p) => isProjectExpanded(p.projectId));
    const nextState: Record<string, boolean> = {};
    for (const p of projects) {
      nextState[p.projectId] = !allExpanded;
    }
    setExpandedProjects(nextState);
  };

  return (
    <aside className="w-72 border-r border-[var(--border-default)] bg-[var(--bg-sidebar)] flex flex-col shrink-0 text-xs">
      {/* Sidebar Header */}
      <div className="p-3 border-b border-[var(--border-default)] flex items-center justify-between font-medium text-[var(--text-secondary)]">
        <div className="flex items-center gap-1.5">
          <Layers className="w-4 h-4 text-[var(--primary-text)]" />
          <span className="font-semibold text-[var(--text-primary)]">工作空间与会话</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--bg-surface-elevated)] border border-[var(--border-default)] font-mono text-[var(--text-muted)]">
            {sessions.length}
          </span>
        </div>

        <div className="flex items-center gap-1">
          {projects.length > 0 && (
            <button
              onClick={toggleAll}
              className="p-1 rounded hover:bg-[var(--bg-surface-elevated)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition cursor-pointer"
              title="全部展开/折叠"
            >
              <ChevronsUpDown className="w-3.5 h-3.5" />
            </button>
          )}

          {onNewSession && (
            <button
              onClick={() => onNewSession(selectedProjectId || projects[0]?.projectId)}
              disabled={isCreatingSession}
              className="p-1 px-1.5 rounded hover:bg-[var(--bg-surface-elevated)] text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-50 transition cursor-pointer flex items-center gap-1"
              title={
                selectedProjectId
                  ? `在当前项目 (${selectedProjectId}) 新建会话`
                  : "新建会话"
              }
            >
              {isCreatingSession ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--primary)]" />
              ) : (
                <Plus className="w-3.5 h-3.5 text-[var(--primary-text)]" />
              )}
            </button>
          )}
        </div>
      </div>

      {/* Search Bar */}
      <div className="px-3 pt-2.5 pb-1">
        <div className="relative flex items-center">
          <Search className="w-3.5 h-3.5 absolute left-2.5 text-[var(--text-muted)]" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="搜索项目或会话..."
            className="w-full bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-md pl-8 pr-2.5 py-1 text-xs text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--primary-border)] transition"
          />
        </div>
      </div>

      {/* Project & Session Tree View */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {filteredProjects.length === 0 && unassignedSessions.length === 0 ? (
          <div className="p-6 text-center text-xs text-[var(--text-muted)] space-y-2">
            <p>{searchTerm ? "无匹配的项目或会话" : "暂无项目"}</p>
          </div>
        ) : (
          filteredProjects.map((project) => {
            const projectSessions = groupedSessions.get(project.projectId) || [];
            const expanded = isProjectExpanded(project.projectId);
            const isProjectSelected =
              selectedProjectId === project.projectId ||
              projectSessions.some((s) => s.sessionId === activeSessionId);

            return (
              <div key={project.projectId} className="space-y-0.5">
                {/* Project Tree Node (Level 1) */}
                <div
                  onClick={() => {
                    toggleProject(project.projectId);
                    onSelectProject?.(project.projectId);
                  }}
                  className={`group flex items-center justify-between px-2 py-1.5 rounded-lg cursor-pointer transition select-none ${
                    isProjectSelected
                      ? "bg-[var(--bg-surface-elevated)] text-[var(--text-primary)] font-medium"
                      : "text-[var(--text-secondary)] hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text-primary)]"
                  }`}
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-[var(--text-muted)] shrink-0">
                      {expanded ? (
                        <ChevronDown className="w-3.5 h-3.5" />
                      ) : (
                        <ChevronRight className="w-3.5 h-3.5" />
                      )}
                    </span>
                    <span className="text-[var(--primary-text)] shrink-0">
                      {expanded ? (
                        <FolderOpen className="w-4 h-4" />
                      ) : (
                        <Folder className="w-4 h-4" />
                      )}
                    </span>
                    <span className="truncate text-xs tracking-tight">
                      {project.displayName || project.projectId}
                    </span>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-[var(--bg-subtle)] border border-[var(--border-default)] font-mono text-[var(--text-muted)]">
                      {projectSessions.length}
                    </span>

                    {onNewSession && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectProject?.(project.projectId);
                          onNewSession(project.projectId);
                        }}
                        disabled={isCreatingSession}
                        className="opacity-0 group-hover:opacity-100 p-1 hover:bg-[var(--bg-surface-hover)] rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] transition cursor-pointer"
                        title={`在 ${project.displayName || project.projectId} 新建会话`}
                      >
                        <Plus className="w-3.5 h-3.5 text-[var(--primary-text)]" />
                      </button>
                    )}
                  </div>
                </div>

                {/* Session List Children (Level 2) */}
                {expanded && (
                  <div className="ml-3 pl-2.5 border-l border-[var(--border-default)] space-y-1 py-0.5">
                    {projectSessions.length === 0 ? (
                      <div className="px-2 py-1.5 text-[11px] text-[var(--text-muted)] flex items-center justify-between">
                        <span>暂无会话</span>
                        {onNewSession && (
                          <button
                            type="button"
                            onClick={() => {
                              onSelectProject?.(project.projectId);
                              onNewSession(project.projectId);
                            }}
                            className="text-[11px] text-[var(--primary-text)] hover:underline flex items-center gap-0.5 cursor-pointer font-medium"
                          >
                            <Plus className="w-3 h-3" />
                            <span>新建</span>
                          </button>
                        )}
                      </div>
                    ) : (
                      projectSessions.map((s) => {
                        const isActive = s.sessionId === activeSessionId;
                        const isDeleting = deletingSessionId === s.sessionId;

                        return (
                          <div
                            key={s.sessionId}
                            onClick={() => onSelectSession(s.sessionId, project.projectId)}
                            className={`group relative px-2.5 py-1.5 rounded-md border text-left cursor-pointer transition flex items-start gap-2 ${
                              isActive
                                ? "bg-[var(--bg-surface-elevated)] border-[var(--primary-border)] text-[var(--text-primary)] shadow-xs"
                                : "border-transparent hover:bg-[var(--bg-surface-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                            }`}
                          >
                            <MessageSquare
                              className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${
                                isActive
                                  ? "text-[var(--primary-text)]"
                                  : "text-[var(--text-muted)]"
                              }`}
                            />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between gap-1">
                                <span className="font-mono text-xs truncate font-medium">
                                  {s.sessionId.replace("ses_", "").slice(0, 8)}...
                                </span>
                                <span
                                  className={`text-[9px] px-1.5 py-0.2 rounded font-mono ${
                                    s.status === "active"
                                      ? "bg-[var(--status-success-bg)] text-[var(--status-success-text)] border border-[var(--status-success-border)]"
                                      : "bg-[var(--bg-subtle)] text-[var(--text-muted)] border border-[var(--border-default)]"
                                  }`}
                                >
                                  {s.status}
                                </span>
                              </div>

                              <div className="flex items-center gap-1 mt-0.5 text-[10px] text-[var(--text-muted)]">
                                <Clock className="w-2.5 h-2.5" />
                                <span>
                                  {new Date(s.lastActiveAt).toLocaleTimeString([], {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  })}
                                </span>
                                {s.repositoryId && (
                                  <span className="ml-auto text-[var(--text-secondary)] font-mono text-[9px] truncate max-w-[80px]">
                                    [{s.repositoryId}]
                                  </span>
                                )}
                              </div>
                            </div>

                            {onDeleteSession && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onDeleteSession(s.sessionId);
                                }}
                                disabled={isDeleting}
                                className="opacity-0 group-hover:opacity-100 hover:text-red-500 hover:bg-red-500/10 text-[var(--text-muted)] p-1 rounded transition cursor-pointer disabled:opacity-100 disabled:cursor-not-allowed shrink-0"
                                title="删除会话"
                              >
                                {isDeleting ? (
                                  <Loader2 className="w-3 h-3 animate-spin text-red-500" />
                                ) : (
                                  <Trash2 className="w-3 h-3" />
                                )}
                              </button>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}

        {/* Unassigned / Legacy Sessions Group (if any) */}
        {unassignedSessions.length > 0 && (
          <div className="pt-2 border-t border-[var(--border-subtle)] space-y-0.5">
            <div className="px-2 py-1 text-[11px] font-medium text-[var(--text-muted)]">
              其他会话 ({unassignedSessions.length})
            </div>
            <div className="ml-3 pl-2.5 border-l border-[var(--border-default)] space-y-1">
              {unassignedSessions.map((s) => {
                const isActive = s.sessionId === activeSessionId;
                const isDeleting = deletingSessionId === s.sessionId;

                return (
                  <div
                    key={s.sessionId}
                    onClick={() => onSelectSession(s.sessionId)}
                    className={`group relative px-2.5 py-1.5 rounded-md border text-left cursor-pointer transition flex items-start gap-2 ${
                      isActive
                        ? "bg-[var(--bg-surface-elevated)] border-[var(--primary-border)] text-[var(--text-primary)] shadow-xs"
                        : "border-transparent hover:bg-[var(--bg-surface-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                    }`}
                  >
                    <MessageSquare
                      className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${
                        isActive ? "text-[var(--primary-text)]" : "text-[var(--text-muted)]"
                      }`}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-1">
                        <span className="font-mono text-xs truncate font-medium">
                          {s.sessionId.replace("ses_", "").slice(0, 8)}...
                        </span>
                        <span className="text-[9px] px-1.5 py-0.2 rounded font-mono bg-[var(--bg-subtle)] text-[var(--text-muted)] border border-[var(--border-default)]">
                          {s.status}
                        </span>
                      </div>
                    </div>

                    {onDeleteSession && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteSession(s.sessionId);
                        }}
                        disabled={isDeleting}
                        className="opacity-0 group-hover:opacity-100 hover:text-red-500 hover:bg-red-500/10 text-[var(--text-muted)] p-1 rounded transition cursor-pointer"
                        title="删除会话"
                      >
                        {isDeleting ? (
                          <Loader2 className="w-3 h-3 animate-spin text-red-500" />
                        ) : (
                          <Trash2 className="w-3 h-3" />
                        )}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
};
