import React, { useState, useMemo } from "react";
import { toast } from "sonner";
import {
  Plus,
  Search,
  GitBranch,
  Clock,
  ArrowRight,
  Trash2,
  Pencil,
  Check,
  X,
  Hash,
  Copy,
  FolderKanban,
  Globe,
  MessageSquare,
  Radio,
  Calendar,
} from "lucide-react";
import { createSession, deleteSession, renameSession } from "../../api/client";
import { useStudio } from "../../context/StudioContext";
import { useConfirm } from "../../context/ConfirmContext";
import type { SessionRoute } from "../../types";
import { formatTimeAgo, formatDateTime } from "../../utils/formatters";
import { copyToClipboard } from "../../utils/clipboard";

interface ColumnDef {
  id: "active" | "idle" | "suspended" | "closed";
  title: string;
  dotColor: string;
  filter: (s: SessionRoute) => boolean;
}

interface SessionCardProps {
  session: SessionRoute;
  onOpen: () => void;
  isEditing: boolean;
  editTitle: string;
  setEditTitle: (val: string) => void;
  onStartRename: (e: React.MouseEvent) => void;
  onSaveRename: (e: React.MouseEvent | React.FormEvent) => void;
  onCancelRename: (e: React.MouseEvent) => void;
  onDelete: (e: React.MouseEvent) => void;
  isDeleting: boolean;
}

function renderStatusBadge(status: SessionRoute["status"]) {
  switch (status) {
    case "active":
      return (
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
          <span>运行中</span>
        </span>
      );
    case "idle":
      return (
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
          <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
          <span>空闲</span>
        </span>
      );
    case "suspended":
      return (
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
          <span>已挂起</span>
        </span>
      );
    case "closing":
    case "archived":
    case "failed":
    default:
      return (
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium bg-neutral-500/10 text-neutral-500 border border-neutral-500/20">
          <span className="w-1.5 h-1.5 rounded-full bg-neutral-400" />
          <span>已归档</span>
        </span>
      );
  }
}

function SessionCard({
  session: s,
  onOpen,
  isEditing,
  editTitle,
  setEditTitle,
  onStartRename,
  onSaveRename,
  onCancelRename,
  onDelete,
  isDeleting,
}: SessionCardProps) {
  const [copied, setCopied] = useState(false);

  const handleCopyId = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    const ok = await copyToClipboard(s.sessionId);
    if (ok) {
      toast.success("已复制会话 ID");
    } else {
      toast.info(`会话 ID: ${s.sessionId.slice(0, 16)}...`);
    }
  };

  const channel =
    s.externalChannel ||
    (s.metadata as any)?.channel ||
    (s.metadata as any)?.source;
  const isGlobal = s.projectId === "global" || s.projectId === "_global";

  return (
    <div
      onClick={onOpen}
      className="group relative flex flex-col justify-between p-4 rounded-[var(--radius-md)] bg-[var(--bg-card)] border border-[var(--border-default)] hover:border-[var(--border-strong)] hover:shadow-xs transition-all cursor-pointer space-y-3"
    >
      {/* 1. Card Top: Title / Inline Edit + Action Buttons */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          {isEditing ? (
            <form
              onSubmit={onSaveRename}
              onClick={(e) => e.stopPropagation()}
              className="flex items-center gap-1.5"
            >
              <input
                type="text"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                className="w-full px-2 py-1 rounded-[var(--radius-xs)] text-xs bg-[var(--bg-canvas)] border border-[var(--border-strong)] text-[var(--text-primary)] outline-none"
                autoFocus
              />
              <button
                type="submit"
                className="p-1 text-emerald-500 hover:text-emerald-400 cursor-pointer"
                title="保存名称"
              >
                <Check className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={onCancelRename}
                className="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
                title="取消"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </form>
          ) : (
            <div className="space-y-1">
              <h4 className="text-[13px] font-semibold text-[var(--text-primary)] group-hover:text-[var(--primary)] transition-colors line-clamp-2 leading-snug">
                {s.title || "新会话"}
              </h4>
            </div>
          )}
        </div>

        {/* Hover Actions */}
        {!isEditing && (
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
            <button
              onClick={onStartRename}
              title="重命名会话"
              className="p-1 rounded-[var(--radius-xs)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)] transition-colors cursor-pointer"
            >
              <Pencil className="w-3 h-3" />
            </button>
            <button
              onClick={onDelete}
              disabled={isDeleting}
              title="删除 / 归档会话"
              className="p-1 rounded-[var(--radius-xs)] text-[var(--text-muted)] hover:text-red-500 hover:bg-[var(--bg-surface-hover)] transition-colors cursor-pointer"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        )}
      </div>

      {/* 2. Middle Row: Session ID pill (with copy) + Status Badge */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={handleCopyId}
          title="点击复制完整 Session ID"
          className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[var(--radius-xs)] font-mono text-[10px] bg-[var(--bg-surface-elevated)] border border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-strong)] transition-all cursor-pointer"
        >
          <Hash className="w-2.5 h-2.5 text-[var(--text-muted)]" />
          <span>{s.sessionId.slice(0, 14)}...</span>
          {copied ? (
            <Check className="w-2.5 h-2.5 text-emerald-500" />
          ) : (
            <Copy className="w-2.5 h-2.5 text-[var(--text-muted)] opacity-50 group-hover:opacity-100" />
          )}
        </button>

        {renderStatusBadge(s.status)}
      </div>

      {/* 3. Details Row: Project, Repository, Channel origin */}
      <div className="flex items-center gap-1.5 flex-wrap text-[10px]">
        {/* Project Badge */}
        <span
          title={`项目: ${s.projectId}`}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[var(--radius-xs)] font-mono bg-[var(--bg-surface)] border border-[var(--border-default)] text-[var(--text-secondary)]"
        >
          {isGlobal ? (
            <Globe className="w-2.5 h-2.5 text-sky-500" />
          ) : (
            <FolderKanban className="w-2.5 h-2.5 text-[var(--text-muted)]" />
          )}
          <span className="truncate max-w-[100px]">{s.projectId}</span>
        </span>

        {/* Repository Badge */}
        {s.repositoryId && (
          <span
            title={`代码库: ${s.repositoryId}`}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[var(--radius-xs)] font-mono bg-[var(--bg-surface)] border border-[var(--border-default)] text-[var(--text-secondary)]"
          >
            <GitBranch className="w-2.5 h-2.5 text-[var(--text-muted)]" />
            <span className="truncate max-w-[90px]">{s.repositoryId}</span>
          </span>
        )}

        {/* Channel Origin Badge */}
        {channel === "feishu" && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[var(--radius-xs)] font-medium bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
            <MessageSquare className="w-2.5 h-2.5" />
            <span>飞书</span>
          </span>
        )}
        {channel === "wecom" && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[var(--radius-xs)] font-medium bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
            <MessageSquare className="w-2.5 h-2.5" />
            <span>企业微信</span>
          </span>
        )}
        {(channel === "web" || (!channel && !s.externalConversationId)) && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[var(--radius-xs)] font-medium bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20">
            <Radio className="w-2.5 h-2.5" />
            <span>Web</span>
          </span>
        )}
      </div>

      {/* 4. Card Footer: Timestamps & Enter Affordance */}
      <div className="pt-2.5 border-t border-[var(--border-subtle)] flex items-center justify-between text-[11px] text-[var(--text-muted)]">
        <div className="flex items-center gap-3">
          <div
            className="flex items-center gap-1 font-mono text-[10px]"
            title={`最后活跃: ${s.lastActiveAt}`}
          >
            <Clock className="w-2.5 h-2.5 text-[var(--text-muted)]" />
            <span>{formatTimeAgo(s.lastActiveAt)}</span>
          </div>
          {s.createdAt && (
            <div
              className="hidden sm:flex items-center gap-1 font-mono text-[10px]"
              title={`创建时间: ${s.createdAt}`}
            >
              <Calendar className="w-2.5 h-2.5 text-[var(--text-muted)]" />
              <span>{formatDateTime(s.createdAt).slice(0, 11)}</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-1 text-[11px] font-medium text-[var(--text-muted)] group-hover:text-[var(--text-primary)] transition-colors">
          <span className="opacity-0 group-hover:opacity-100 transition-opacity">
            进入会话
          </span>
          <ArrowRight className="w-3 h-3 transition-transform group-hover:translate-x-0.5" />
        </div>
      </div>
    </div>
  );
}

export function SessionBoard() {
  const {
    activeProjectId,
    sessions,
    setSessions,
    openSession,
    refreshSessions,
  } = useStudio();
  const confirm = useConfirm();

  const [searchQuery, setSearchQuery] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState<string>("");

  // 4 Git-Flow lifecycle columns
  const columns: ColumnDef[] = [
    {
      id: "active",
      title: "ACTIVE",
      dotColor: "bg-emerald-500",
      filter: (s) => s.status === "active",
    },
    {
      id: "idle",
      title: "IDLE",
      dotColor: "bg-blue-500",
      filter: (s) => s.status === "idle",
    },
    {
      id: "suspended",
      title: "SUSPENDED",
      dotColor: "bg-amber-500",
      filter: (s) => s.status === "suspended",
    },
    {
      id: "closed",
      title: "CLOSED / ARCHIVED",
      dotColor: "bg-neutral-500",
      filter: (s) =>
        s.status === "closing" ||
        s.status === "archived" ||
        s.status === "failed",
    },
  ];

  // Filter sessions by search query (matches title or sessionId or repo or project or channel)
  // and exclude scheduled task sessions
  const filteredSessions = useMemo(() => {
    const nonTaskSessions = sessions.filter((s) => s.source !== "task");
    if (!searchQuery.trim()) return nonTaskSessions;
    const q = searchQuery.toLowerCase();
    return nonTaskSessions.filter(
      (s) =>
        (s.title && s.title.toLowerCase().includes(q)) ||
        s.sessionId.toLowerCase().includes(q) ||
        (s.projectId && s.projectId.toLowerCase().includes(q)) ||
        (s.repositoryId && s.repositoryId.toLowerCase().includes(q)) ||
        (s.status && s.status.toLowerCase().includes(q)) ||
        (s.externalChannel && s.externalChannel.toLowerCase().includes(q))
    );
  }, [sessions, searchQuery]);

  const handleCreateSession = async () => {
    if (isCreating) return;
    try {
      setIsCreating(true);
      const res = await createSession({
        projectId: activeProjectId || undefined,
      });
      await refreshSessions();
      if (res?.session?.sessionId) {
        openSession(res.session.sessionId);
      }
    } catch (err) {
      console.error("Failed to create session:", err);
    } finally {
      setIsCreating(false);
    }
  };

  const handleDeleteSession = async (
    e: React.MouseEvent,
    sessionId: string
  ) => {
    e.stopPropagation();
    const ok = await confirm({
      title: "Archive / Delete Session",
      description: `Are you sure you want to delete session ${sessionId.slice(0, 16)}? This will clean up the workspace and worktree.`,
      confirmText: "Delete",
      variant: "destructive",
    });
    if (!ok) return;

    try {
      setDeletingId(sessionId);
      await deleteSession(sessionId);
      setSessions((prev) => prev.filter((s) => s.sessionId !== sessionId));
      toast.success("Session deleted successfully");
    } catch (err: any) {
      console.error("Failed to delete session:", err);
      toast.error(`Delete failed: ${err.message || String(err)}`);
    } finally {
      setDeletingId(null);
    }
  };

  const handleStartRename = (e: React.MouseEvent, s: SessionRoute) => {
    e.stopPropagation();
    setEditingSessionId(s.sessionId);
    setEditTitle(s.title ?? "");
  };

  const handleSaveRename = async (
    e: React.MouseEvent | React.FormEvent,
    sessionId: string
  ) => {
    e.stopPropagation();
    if (e.type === "submit") e.preventDefault();
    const clean = editTitle.trim();
    if (!clean) return;
    try {
      await renameSession(sessionId, clean);
      setSessions((prev) =>
        prev.map((s) => (s.sessionId === sessionId ? { ...s, title: clean } : s))
      );
      setEditingSessionId(null);
      toast.success("Session renamed");
    } catch (err: any) {
      toast.error(`Rename failed: ${err.message || String(err)}`);
    }
  };

  const handleCancelRename = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingSessionId(null);
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-[var(--bg-canvas)] select-text">
      {/* Vercel-style Top Toolbar */}
      <div className="h-12 px-6 flex items-center justify-between border-b border-[var(--border-default)] bg-[var(--bg-header)] shrink-0">
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs uppercase tracking-wider text-[var(--text-muted)] font-semibold">
            Session Lifecycle
          </span>
          <span className="text-[11px] font-mono text-[var(--text-muted)] px-1.5 py-0.5 rounded-[var(--radius-xs)] bg-[var(--bg-surface-elevated)] border border-[var(--border-default)]">
            {filteredSessions.length} total
          </span>
        </div>

        {/* Search & Actions */}
        <div className="flex items-center gap-3">
          <div className="relative w-48 md:w-64">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search title, ID, project or repo..."
              className="w-full pl-8 pr-2.5 py-1 rounded-[var(--radius-sm)] text-xs bg-[var(--bg-canvas)] border border-[var(--border-default)] text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-hidden focus:border-[var(--border-focus)] transition-colors"
            />
          </div>

          <button
            onClick={handleCreateSession}
            disabled={isCreating}
            className="px-3 py-1 rounded-[var(--radius-sm)] text-xs font-medium bg-[var(--primary)] text-[var(--text-inverted)] hover:opacity-90 transition-opacity cursor-pointer flex items-center gap-1.5 shrink-0"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>{isCreating ? "Creating..." : "New Session"}</span>
          </button>
        </div>
      </div>

      {/* Modern Vercel-style Board with Independent Column Vertical Scrolling */}
      <div className="flex-1 overflow-x-auto overflow-y-hidden p-4 md:p-6 min-h-0">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 h-full min-w-[1050px]">
          {columns.map((col) => {
            const colSessions = filteredSessions.filter(col.filter);

            return (
              <div
                key={col.id}
                className="flex flex-col h-full min-h-0"
              >
                {/* Column Plain Text Header */}
                <div className="flex items-center justify-between pb-3 px-1 shrink-0 select-none">
                  <div className="flex items-center gap-2">
                    <span
                      className={`w-2 h-2 rounded-full ${col.dotColor} ${
                        col.id === "active" ? "animate-pulse" : ""
                      }`}
                    />
                    <h3 className="font-mono text-xs font-semibold tracking-wider text-[var(--text-primary)] uppercase">
                      {col.title}
                    </h3>
                  </div>

                  <span className="font-mono text-[11px] font-medium text-[var(--text-muted)] px-2 py-0.5 rounded-full bg-[var(--bg-surface-elevated)] border border-[var(--border-default)]">
                    {colSessions.length}
                  </span>
                </div>

                {/* Independent Scrollable Column Stack */}
                <div className="flex-1 overflow-y-auto min-h-0 pr-1 space-y-3">
                  {colSessions.length === 0 ? (
                    <div className="border border-dashed border-[var(--border-default)] rounded-[var(--radius-md)] p-8 text-center text-xs text-[var(--text-muted)] font-mono flex flex-col items-center justify-center gap-1">
                      <span>No sessions</span>
                      <span className="text-[10px] text-[var(--text-muted)] opacity-70">
                        暂无此状态会话
                      </span>
                    </div>
                  ) : (
                    colSessions.map((s) => (
                      <SessionCard
                        key={s.sessionId}
                        session={s}
                        onOpen={() => openSession(s.sessionId)}
                        isEditing={editingSessionId === s.sessionId}
                        editTitle={editTitle}
                        setEditTitle={setEditTitle}
                        onStartRename={(e) => handleStartRename(e, s)}
                        onSaveRename={(e) => handleSaveRename(e, s.sessionId)}
                        onCancelRename={handleCancelRename}
                        onDelete={(e) => handleDeleteSession(e, s.sessionId)}
                        isDeleting={deletingId === s.sessionId}
                      />
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
