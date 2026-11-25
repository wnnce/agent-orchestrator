import React, { useState, useMemo } from "react";
import { AnimatePresence, m } from "motion/react";
import { toast } from "sonner";
import {
  Plus,
  Search,
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
  Cpu,
  Loader2,
} from "lucide-react";
import { generatePath, useNavigate } from "react-router";
import { runtimesApi, sessionsApi } from "../../api";
import { useStudio } from "../../context/StudioContext";
import { useConfirm } from "../../context/ConfirmContext";
import { useCurrentProject } from "../../layouts/ProjectLayout";
import { ROUTES } from "../../routes";
import type { RuntimeInfo, SessionRoute } from "../../types";
import { formatTimeAgo, formatDateTime, formatTokenCount } from "../../utils/formatters";
import { copyToClipboard } from "../../utils/clipboard";
import { EASE_OUT_EXPO, SPRING_SOFT } from "../../utils/motion";

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
      className="group relative flex flex-col justify-between p-4 rounded-[var(--radius-md)] bg-[var(--bg-card)] border border-[var(--border-default)] hover:border-[var(--border-strong)] hover:-translate-y-0.5 active:scale-[0.99] hover:shadow-xs transition-all duration-150 cursor-pointer space-y-3"
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

        {s.runtime && s.runtime !== "unknown" && (
          <span
            title={[s.runtime, s.model, s.reasoningEffort].filter(Boolean).join(" · ")}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[var(--radius-xs)] font-mono bg-[var(--bg-surface)] border border-[var(--border-default)] text-[var(--text-secondary)] max-w-[180px]"
          >
            <Cpu className="w-2.5 h-2.5 text-[var(--text-muted)] shrink-0" />
            <span className="truncate">
              {s.runtime}
              {s.model ? ` · ${s.model}` : ""}
            </span>
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
  const activeProject = useCurrentProject();
  const activeProjectId = activeProject.projectId;
  const { sessions, setSessions, refreshSessions } = useStudio();
  const navigate = useNavigate();
  const confirm = useConfirm();

  const openSession = (sessionId: string) => {
    navigate(generatePath(ROUTES.session, { projectId: activeProjectId, sessionId }));
  };

  const [searchQuery, setSearchQuery] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [runtimes, setRuntimes] = useState<RuntimeInfo[]>([]);
  const [isLoadingRuntimes, setIsLoadingRuntimes] = useState(false);
  const [selectedRuntime, setSelectedRuntime] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedEffort, setSelectedEffort] = useState("");
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
        (s.status && s.status.toLowerCase().includes(q)) ||
        (s.externalChannel && s.externalChannel.toLowerCase().includes(q))
    );
  }, [sessions, searchQuery]);

  const activeRuntimeInfo = useMemo(
    () => runtimes.find((rt) => rt.type === selectedRuntime) ?? null,
    [runtimes, selectedRuntime],
  );
  const activeModelInfo = useMemo(
    () => activeRuntimeInfo?.models.find((m) => m.id === selectedModel) ?? null,
    [activeRuntimeInfo, selectedModel],
  );
  const availableEfforts = useMemo(() => {
    if (activeModelInfo) return activeModelInfo.reasoningEfforts;
    return activeRuntimeInfo?.defaultReasoningEfforts ?? [];
  }, [activeModelInfo, activeRuntimeInfo]);

  const applyRuntimeSelection = (
    runtimeType: string,
    runtimeList: RuntimeInfo[],
  ) => {
    setSelectedRuntime(runtimeType);
    const rtInfo = runtimeList.find((r) => r.type === runtimeType);
    const projectDefault = activeProject?.runtime;
    const isProjectDefaultRuntime = projectDefault?.type === runtimeType;

    let nextModel = "";
    if (
      isProjectDefaultRuntime &&
      projectDefault?.model &&
      rtInfo?.models.some((m) => m.id === projectDefault.model)
    ) {
      nextModel = projectDefault.model;
    } else if (rtInfo && rtInfo.models.length > 0) {
      nextModel = rtInfo.models[0]!.id;
    }
    setSelectedModel(nextModel);

    const modelObj = rtInfo?.models.find((m) => m.id === nextModel);
    const efforts = modelObj ? modelObj.reasoningEfforts : (rtInfo?.defaultReasoningEfforts ?? []);
    if (
      isProjectDefaultRuntime &&
      projectDefault?.reasoningEffort &&
      efforts.includes(projectDefault.reasoningEffort)
    ) {
      setSelectedEffort(projectDefault.reasoningEffort);
    } else if (
      modelObj?.defaultReasoningEffort &&
      efforts.includes(modelObj.defaultReasoningEffort)
    ) {
      setSelectedEffort(modelObj.defaultReasoningEffort);
    } else {
      setSelectedEffort("");
    }
  };

  const handleOpenCreateModal = async () => {
    setCreateModalOpen(true);
    setIsLoadingRuntimes(true);
    try {
      const list = await runtimesApi.list();
      setRuntimes(list);
      const preferredRuntime =
        activeProject?.runtime?.type && list.some((r) => r.type === activeProject.runtime?.type)
          ? activeProject.runtime.type
          : (list[0]?.type ?? "");
      applyRuntimeSelection(preferredRuntime, list);
    } catch (err: any) {
      console.error("Failed to load runtimes:", err);
      toast.error(`加载 Runtime 列表失败: ${err.message || String(err)}`);
    } finally {
      setIsLoadingRuntimes(false);
    }
  };

  const handleModelChange = (modelId: string) => {
    setSelectedModel(modelId);
    const modelObj = activeRuntimeInfo?.models.find((m) => m.id === modelId);
    const efforts = modelObj
      ? modelObj.reasoningEfforts
      : (activeRuntimeInfo?.defaultReasoningEfforts ?? []);
    if (selectedEffort && efforts.includes(selectedEffort)) {
      return;
    }
    if (modelObj?.defaultReasoningEffort && efforts.includes(modelObj.defaultReasoningEffort)) {
      setSelectedEffort(modelObj.defaultReasoningEffort);
    } else {
      setSelectedEffort("");
    }
  };

  const handleCreateSession = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (isCreating || isLoadingRuntimes) return;
    try {
      setIsCreating(true);
      const res = await sessionsApi.create({
        projectId: activeProjectId || undefined,
        ...(selectedRuntime ? { runtime: selectedRuntime } : {}),
        ...(selectedModel ? { model: selectedModel } : {}),
        ...(selectedEffort ? { reasoningEffort: selectedEffort } : {}),
      });
      setCreateModalOpen(false);
      await refreshSessions(activeProjectId);
      if (res?.session?.sessionId) {
        openSession(res.session.sessionId);
      }
    } catch (err: any) {
      console.error("Failed to create session:", err);
      toast.error(`创建会话失败: ${err.message || String(err)}`);
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
      await sessionsApi.delete(sessionId);
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
      await sessionsApi.rename(sessionId, clean);
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
            onClick={handleOpenCreateModal}
            disabled={isCreating}
            className="px-3 py-1 rounded-[var(--radius-sm)] text-xs font-medium bg-[var(--primary)] text-[var(--text-inverted)] hover:opacity-90 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed transition-all cursor-pointer flex items-center gap-1.5 shrink-0"
          >
            {isCreating ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Plus className="w-3.5 h-3.5" />
            )}
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
                    <AnimatePresence initial={false}>
                      {colSessions.map((s, idx) => (
                        <m.div
                          key={s.sessionId}
                          initial={{ opacity: 0, y: 6 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, scale: 0.96 }}
                          transition={{
                            duration: 0.18,
                            delay: Math.min(idx * 0.025, 0.18),
                            ease: EASE_OUT_EXPO,
                          }}
                        >
                          <SessionCard
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
                        </m.div>
                      ))}
                    </AnimatePresence>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Create Session Modal */}
      <AnimatePresence>
        {createModalOpen && (
          <m.div
            key="create-session-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-[1px] p-4"
            onClick={() => {
              if (!isCreating) setCreateModalOpen(false);
            }}
          >
            <m.div
              initial={{ opacity: 0, scale: 0.96, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 6 }}
              transition={SPRING_SOFT}
              className="w-full max-w-md rounded-[var(--radius-md)] border border-[var(--border-strong)] bg-[var(--bg-card)] shadow-xl overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-4 py-3 border-b border-[var(--border-default)] flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Cpu className="w-4 h-4 text-[var(--primary)]" />
                  <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                    新建会话 (New Session)
                  </h3>
                </div>
                <button
                  type="button"
                  disabled={isCreating}
                  onClick={() => setCreateModalOpen(false)}
                  className="p-1 rounded-[var(--radius-xs)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                  title="关闭"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <form onSubmit={handleCreateSession} className="p-4 space-y-4">
                {isLoadingRuntimes ? (
                  <div className="py-8 flex items-center justify-center gap-2 text-xs text-[var(--text-muted)] font-mono">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>正在加载可用 Runtime 与模型列表...</span>
                  </div>
                ) : (
                  <>
                    {/* 1. Runtime selector */}
                    <div className="space-y-1.5">
                      <label className="block text-[11px] font-medium text-[var(--text-secondary)]">
                        Runtime
                      </label>
                      <select
                        value={selectedRuntime}
                        disabled={isCreating || runtimes.length === 0}
                        onChange={(e) => applyRuntimeSelection(e.target.value, runtimes)}
                        className="w-full px-2.5 py-2 rounded-[var(--radius-sm)] text-xs font-mono bg-[var(--bg-input)] border border-[var(--border-default)] text-[var(--text-primary)] outline-hidden focus:border-[var(--primary)] disabled:opacity-60 disabled:cursor-not-allowed"
                      >
                        {runtimes.map((rt) => (
                          <option key={rt.type} value={rt.type}>
                            {rt.name}
                            {activeProject?.runtime?.type === rt.type ? " (项目默认)" : ""}
                          </option>
                        ))}
                      </select>
                      {activeRuntimeInfo?.description && (
                        <p className="text-[11px] text-[var(--text-muted)]">
                          {activeRuntimeInfo.description}
                        </p>
                      )}
                    </div>

                    {/* 2. Model candidate selector (candidates only, no custom input) */}
                    <div className="space-y-1.5">
                      <label className="block text-[11px] font-medium text-[var(--text-secondary)]">
                        模型 (Model)
                      </label>
                      <select
                        value={selectedModel}
                        disabled={isCreating}
                        onChange={(e) => handleModelChange(e.target.value)}
                        className="w-full px-2.5 py-2 rounded-[var(--radius-sm)] text-xs font-mono bg-[var(--bg-input)] border border-[var(--border-default)] text-[var(--text-primary)] outline-hidden focus:border-[var(--primary)] disabled:opacity-60 disabled:cursor-not-allowed"
                      >
                        <option value="">
                          {activeRuntimeInfo && activeRuntimeInfo.models.length === 0
                            ? "使用 Runtime 默认模型（暂无候选模型）"
                            : "使用 Runtime 默认模型"}
                        </option>
                        {(activeRuntimeInfo?.models ?? []).map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.displayName !== model.id
                              ? `${model.displayName} (${model.id})`
                              : model.id}
                            {model.contextWindow
                              ? ` · ${formatTokenCount(model.contextWindow)}`
                              : ""}
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* 3. Reasoning Effort selector */}
                    <div className="space-y-1.5">
                      <label className="block text-[11px] font-medium text-[var(--text-secondary)]">
                        思考强度 (Reasoning Effort)
                      </label>
                      <select
                        value={selectedEffort}
                        disabled={isCreating || availableEfforts.length === 0}
                        onChange={(e) => setSelectedEffort(e.target.value)}
                        className="w-full px-2.5 py-2 rounded-[var(--radius-sm)] text-xs font-mono bg-[var(--bg-input)] border border-[var(--border-default)] text-[var(--text-primary)] outline-hidden focus:border-[var(--primary)] disabled:opacity-60 disabled:cursor-not-allowed"
                      >
                        {availableEfforts.length === 0 ? (
                          <option value="">当前模型不支持思考强度</option>
                        ) : (
                          <>
                            <option value="">
                              默认
                              {activeModelInfo?.defaultReasoningEffort
                                ? ` (${activeModelInfo.defaultReasoningEffort})`
                                : ""}
                            </option>
                            {availableEfforts.map((effort) => (
                              <option key={effort} value={effort}>
                                {effort}
                              </option>
                            ))}
                          </>
                        )}
                      </select>
                    </div>
                  </>
                )}

                <div className="pt-2 border-t border-[var(--border-subtle)] flex items-center justify-end gap-2">
                  <button
                    type="button"
                    disabled={isCreating}
                    onClick={() => setCreateModalOpen(false)}
                    className="px-3 py-1.5 rounded-[var(--radius-sm)] text-xs font-medium border border-[var(--border-default)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    disabled={isCreating || isLoadingRuntimes || !selectedRuntime}
                    className="px-3.5 py-1.5 rounded-[var(--radius-sm)] text-xs font-medium bg-[var(--primary)] text-[var(--text-inverted)] hover:opacity-90 active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed transition-all cursor-pointer inline-flex items-center gap-1.5"
                  >
                    {isCreating && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    <span>{isCreating ? "创建中..." : "创建会话"}</span>
                  </button>
                </div>
              </form>
            </m.div>
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}
