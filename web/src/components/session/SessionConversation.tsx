import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, m } from "motion/react";
import { toast } from "sonner";
import {
  Activity,
  AlertCircle,
  Check,
  ChevronRight,
  Clock,
  Copy,
  Download,
  FileCode,
  Info,
  MessageSquare,
  Search,
} from "lucide-react";
import { sessionsApi } from "../../api";
import { useStudio } from "../../context/StudioContext";
import { useCurrentProject } from "../../layouts/ProjectLayout";
import { queryKeys } from "../../queries";
import type {
  ArtifactRecord,
  ChatMessage,
  RuntimeEvent,
  SessionRoute,
  SessionUsageSummary,
  TaskExecutionRecord,
} from "../../types";
import { copyToClipboard } from "../../utils/clipboard";
import {
  calculateCacheHitRate,
  formatDateTime,
  formatDuration,
  formatTokenCount,
  mergeTurnUsageIntoSummary,
} from "../../utils/formatters";
import {
  applyEventToAssistantMessage,
  parseTurnUsage,
  reconstructMessagesFromEvents,
} from "../../utils/messageParser";
import { EASE_OUT_EXPO } from "../../utils/motion";
import { ChatArea } from "../ChatArea";
import { Inspector } from "../Inspector";

export interface SessionInspectorData {
  events: RuntimeEvent[];
  artifacts: ArtifactRecord[];
  session: SessionRoute | null;
  usage: SessionUsageSummary | null;
}

export interface SessionConversationProps {
  sessionId: string;
  /** Force read-only mode (disables message composer & interrupt, e.g. for task execution playback). */
  readOnly?: boolean;
  /** Custom read-only banner shown at the bottom when `readOnly` is true. */
  readOnlyReason?: string;
  /**
   * "standalone" (default, Sessions page): ChatArea + collapsible right Inspector drawer.
   * "embedded" (Tasks Studio): inline top execution bar with Chat / Events / Artifacts / Info tabs.
   * "canvas" (Pipeline Workbench): pure centered ChatArea without top bar; exposes inspector data via callback.
   */
  mode?: "standalone" | "embedded" | "canvas";
  /** Optional task execution metadata shown in embedded mode or Inspector. */
  taskExecution?: TaskExecutionRecord | null;
  /** Optional callback receiving live session inspector data (used in "canvas" mode). */
  onInspectorDataChange?: (data: SessionInspectorData) => void;
}

function isTerminalStatus(status?: SessionRoute["status"]): boolean {
  return (
    status === "closed" ||
    status === "archived" ||
    status === "closing" ||
    status === "failed"
  );
}

export function SessionConversation({
  sessionId,
  readOnly = false,
  readOnlyReason,
  mode = "standalone",
  taskExecution = null,
  onInspectorDataChange,
}: SessionConversationProps) {
  const activeProject = useCurrentProject();
  const activeProjectId = activeProject.projectId;
  const qc = useQueryClient();
  const { sessions, setSessions, showInspector } = useStudio();
  const activeSession = useMemo(
    () => sessions.find((s) => s.sessionId === sessionId) ?? null,
    [sessions, sessionId],
  );

  // React Query caches initial transcript, session metadata, and artifacts so re-entering
  // a session or pipeline stage renders instantaneously without a loading flash.
  const sessionInfoQuery = useQuery({
    queryKey: queryKeys.sessionDetail(sessionId),
    queryFn: () => sessionsApi.get(sessionId),
    enabled: Boolean(sessionId),
  });

  const artifactsQuery = useQuery({
    queryKey: queryKeys.sessionArtifacts(sessionId),
    queryFn: () => sessionsApi.listArtifacts(sessionId),
    enabled: Boolean(sessionId),
  });

  const historyEventsQuery = useQuery({
    queryKey: queryKeys.sessionEvents(sessionId),
    queryFn: () => sessionsApi.listEvents(sessionId),
    enabled: Boolean(sessionId),
  });

  // Live SSE streaming state stays local to avoid high-frequency React Query cache churn
  // on per-token deltas, and syncs back into the query cache when turns settle.
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [hydratedSessionId, setHydratedSessionId] = useState<string | null>(null);
  const [liveStatusOverride, setLiveStatusOverride] = useState<SessionRoute["status"] | null>(null);
  const [liveUsageOverride, setLiveUsageOverride] = useState<SessionUsageSummary | null>(null);

  const artifacts = artifactsQuery.data ?? [];
  const sessionDetail: SessionRoute | null = useMemo(() => {
    const base = sessionInfoQuery.data?.session ?? null;
    if (!base) return null;
    return liveStatusOverride ? { ...base, status: liveStatusOverride } : base;
  }, [sessionInfoQuery.data?.session, liveStatusOverride]);
  const sessionUsage = liveUsageOverride ?? sessionInfoQuery.data?.usage ?? null;
  const sessionNotFound = Boolean(sessionInfoQuery.isError);

  const isLoadingHistory = historyEventsQuery.isPending && hydratedSessionId !== sessionId;

  // Embedded mode sub-tab state
  const [embeddedTab, setEmbeddedTab] = useState<"chat" | "events" | "artifacts" | "info">("chat");
  const [eventFilter, setEventFilter] = useState("");
  const [expandedEvents, setExpandedEvents] = useState<Record<number, boolean>>({});
  const [copiedId, setCopiedId] = useState(false);

  const unsubscribeRef = useRef<(() => void) | null>(null);
  const artifactDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const eventBufferRef = useRef<RuntimeEvent[]>([]);
  const throttleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSequenceRef = useRef<number>(0);
  const eventsRef = useRef<RuntimeEvent[]>([]);
  const historyDataRef = useRef<RuntimeEvent[] | undefined>(undefined);
  historyDataRef.current = historyEventsQuery.data;
  const hasHistory = historyEventsQuery.data !== undefined;
  const baseUsageRef = useRef<SessionUsageSummary | null>(null);
  baseUsageRef.current = sessionInfoQuery.data?.usage ?? null;

  const flushEventBuffer = useCallback(() => {
    if (throttleTimerRef.current) {
      clearTimeout(throttleTimerRef.current);
      throttleTimerRef.current = null;
    }
    const buffered = eventBufferRef.current;
    if (buffered.length === 0) return;
    eventBufferRef.current = [];

    setMessages((prev) => {
      const idx = prev.findLastIndex((msg) => msg.role === "assistant");
      if (idx === -1) return prev;
      const updated = [...prev];
      const asst = {
        ...updated[idx]!,
        parts: [...(updated[idx]!.parts || [])],
      };
      for (const evt of buffered) {
        applyEventToAssistantMessage(asst, evt);
      }
      updated[idx] = asst;
      return updated;
    });
  }, []);

  useEffect(() => {
    setEmbeddedTab("chat");
    setEventFilter("");
    setExpandedEvents({});
    setLiveStatusOverride(null);
    setLiveUsageOverride(null);
    return () => {
      if (artifactDebounceTimerRef.current) {
        clearTimeout(artifactDebounceTimerRef.current);
      }
      if (throttleTimerRef.current) {
        clearTimeout(throttleTimerRef.current);
        throttleTimerRef.current = null;
      }
      eventBufferRef.current = [];
    };
  }, [sessionId]);

  const matchingActiveSession =
    activeSession?.sessionId === sessionId ? activeSession : null;
  const currentSession = sessionDetail || matchingActiveSession;

  const isTaskSession = currentSession?.source === "task";
  const hasTerminalEvent = events.some(
    (e) => e.type === "session.closed" || e.type === "session.archived",
  );
  const isTerminal = Boolean(
    sessionNotFound ||
      isTerminalStatus(currentSession?.status) ||
      (currentSession?.deletedAt && currentSession.deletedAt > 0) ||
      hasTerminalEvent,
  );
  const isClosed = Boolean(readOnly || isTaskSession || isTerminal);

  const handleEvent = useCallback(
    (evt: RuntimeEvent) => {
      if (typeof evt.sequence === "number") {
        if (evt.sequence <= lastSequenceRef.current) {
          return;
        }
        lastSequenceRef.current = evt.sequence;
      }

      eventsRef.current = [...eventsRef.current, evt];
      setEvents(eventsRef.current);

      if (evt.type === "turn.started") {
        flushEventBuffer();
        setIsRunning(true);
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === "assistant" && last.status === "streaming") {
            return prev;
          }
          return [
            ...prev,
            {
              id: `asst_${evt.payload?.turnId || Date.now()}`,
              role: "assistant",
              content: "",
              parts: [],
              status: "streaming",
              timestamp: Date.now(),
            },
          ];
        });
      } else if (
        evt.type === "turn.completed" ||
        evt.type === "turn.failed" ||
        evt.type === "turn.interrupted"
      ) {
        flushEventBuffer();
        setIsRunning(false);
        setMessages((prev) => {
          const idx = prev.findLastIndex((msg) => msg.role === "assistant");
          if (idx === -1) return prev;
          const updated = [...prev];
          const asst = {
            ...updated[idx]!,
            parts: [...(updated[idx]!.parts || [])],
          };
          applyEventToAssistantMessage(asst, evt);
          updated[idx] = asst;
          return updated;
        });
        const turnUsage = parseTurnUsage(evt.payload?.usage);
        if (turnUsage) {
          setLiveUsageOverride((prev) =>
            mergeTurnUsageIntoSummary(prev ?? baseUsageRef.current, turnUsage),
          );
        }
        qc.setQueryData<RuntimeEvent[]>(queryKeys.sessionEvents(sessionId), eventsRef.current);
        void qc.invalidateQueries({ queryKey: queryKeys.sessionArtifacts(sessionId) });
        void qc.invalidateQueries({ queryKey: queryKeys.sessionDetail(sessionId) });
        if (!readOnly && activeProjectId) {
          void qc.invalidateQueries({ queryKey: queryKeys.sessions(activeProjectId) });
        }
      } else if (evt.type === "session.closed" || evt.type === "session.archived") {
        flushEventBuffer();
        const nextStatus = evt.type === "session.closed" ? "closed" : "archived";
        setLiveStatusOverride(nextStatus);
        void qc.invalidateQueries({ queryKey: queryKeys.sessionDetail(sessionId) });
        if (!readOnly) {
          setSessions((prev) =>
            prev.map((s) => (s.sessionId === sessionId ? { ...s, status: nextStatus } : s)),
          );
          toast.info("Session has been closed / archived");
        }
        setIsRunning(false);
      } else if (evt.type === "artifact.created") {
        if (artifactDebounceTimerRef.current) clearTimeout(artifactDebounceTimerRef.current);
        artifactDebounceTimerRef.current = setTimeout(() => {
          void qc.invalidateQueries({ queryKey: queryKeys.sessionArtifacts(sessionId) });
        }, 150);
      } else if (evt.type === "session.runtime_reset" && !readOnly) {
        toast.warning("运行时会话已重置，Agent 不再保留之前的对话上下文");
      } else if (evt.type === "session.renamed" && evt.payload?.title) {
        const newTitle = evt.payload.title;
        setSessions((prev) =>
          prev.map((s) => (s.sessionId === sessionId ? { ...s, title: newTitle } : s)),
        );
      } else {
        eventBufferRef.current.push(evt);
        if (!throttleTimerRef.current) {
          throttleTimerRef.current = setTimeout(() => {
            throttleTimerRef.current = null;
            flushEventBuffer();
          }, 80);
        }
      }
    },
    [sessionId, activeProjectId, readOnly, setSessions, flushEventBuffer, qc],
  );

  // Hydrate local streaming state once per sessionId from React Query cached history
  // and attach SSE from maxSeq. Using `hasHistory` keeps the SSE connection stable across
  // cache updates and background refetches.
  useEffect(() => {
    const history = historyDataRef.current;
    if (!hasHistory || !history) {
      eventsRef.current = [];
      setMessages([]);
      setEvents([]);
      setIsRunning(false);
      return;
    }

    if (unsubscribeRef.current) {
      unsubscribeRef.current();
      unsubscribeRef.current = null;
    }
    eventBufferRef.current = [];
    if (throttleTimerRef.current) {
      clearTimeout(throttleTimerRef.current);
      throttleTimerRef.current = null;
    }

    eventsRef.current = history;
    setEvents(history);
    const { messages: parsed, isRunning: running } = reconstructMessagesFromEvents(history);
    setMessages(parsed);
    setIsRunning(running);
    setHydratedSessionId(sessionId);

    const maxSeq = history.reduce((max, e) => Math.max(max, e.sequence ?? 0), 0);
    lastSequenceRef.current = maxSeq;

    const alreadyEnded = history.some(
      (e) => e.type === "session.closed" || e.type === "session.archived",
    );
    if (!alreadyEnded) {
      unsubscribeRef.current = sessionsApi.subscribeEvents(
        sessionId,
        handleEvent,
        (err) => console.warn("SSE connection state change / reconnecting:", err),
        maxSeq,
      );
    }

    return () => {
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
      eventBufferRef.current = [];
      if (throttleTimerRef.current) {
        clearTimeout(throttleTimerRef.current);
        throttleTimerRef.current = null;
      }
      if (eventsRef.current.length > 0) {
        qc.setQueryData<RuntimeEvent[]>(queryKeys.sessionEvents(sessionId), eventsRef.current);
      }
    };
  }, [sessionId, hasHistory, handleEvent, qc]);

  const handleSendMessage = async (text: string): Promise<boolean> => {
    if (!text.trim() || isRunning) return false;
    if (isClosed) {
      toast.error("Session is read-only");
      return false;
    }

    try {
      const res = await sessionsApi.postTurn(sessionId, text);
      const turn = res?.turn;

      setMessages((prev) => [
        ...prev,
        {
          id: turn?.id || `usr_${Date.now()}`,
          role: "user",
          content: text,
          timestamp: turn?.createdAt ? new Date(turn.createdAt).getTime() : Date.now(),
        },
      ]);

      setIsRunning(true);
      return true;
    } catch (err: any) {
      const errMsg = err.message || String(err);
      toast.error(`Turn failed: ${errMsg}`);
      setIsRunning(false);

      if (
        errMsg.includes("archived") ||
        errMsg.includes("closing") ||
        errMsg.includes("read-only") ||
        errMsg.includes("session_not_found")
      ) {
        setLiveStatusOverride("archived");
        void qc.invalidateQueries({ queryKey: queryKeys.sessionDetail(sessionId) });
        setSessions((prev) =>
          prev.map((s) => (s.sessionId === sessionId ? { ...s, status: "archived" } : s)),
        );
      }
      return false;
    }
  };

  const handleInterrupt = async () => {
    if (readOnly || isTaskSession) return;
    try {
      await sessionsApi.interruptTurn(sessionId);
      setIsRunning(false);
      setMessages((prev) => {
        const idx = prev.findLastIndex((msg) => msg.role === "assistant");
        if (idx === -1) return prev;
        const updated = [...prev];
        const asst = {
          ...updated[idx]!,
          status: "interrupted" as const,
          parts: (updated[idx]!.parts || []).map((p) =>
            p.status === "streaming"
              ? { ...p, status: "completed" as const }
              : p.status === "running"
                ? { ...p, status: "failed" as const }
                : p,
          ),
        };
        updated[idx] = asst;
        return updated;
      });
      toast.info("Turn interrupted");
    } catch (err: any) {
      toast.error(`Interrupt failed: ${err.message || String(err)}`);
    }
  };

  const visibleArtifacts = useMemo(
    () => artifacts.filter((art) => art.kind !== "agent-message"),
    [artifacts],
  );
  const filteredEvents = useMemo(
    () =>
      eventFilter.trim()
        ? events.filter((e) => e.type.toLowerCase().includes(eventFilter.toLowerCase()))
        : events,
    [events, eventFilter],
  );

  const resolvedClosedReason =
    readOnlyReason ??
    (readOnly || isTaskSession
      ? isRunning
        ? "Task execution is running — live view (read-only)."
        : "Task execution session — read-only."
      : sessionNotFound
        ? "This session no longer exists or has been deleted."
        : currentSession?.status === "closed"
          ? "This session is closed and read-only."
          : currentSession?.status === "archived"
            ? "This session is archived and read-only."
            : currentSession?.status === "closing"
              ? "This session is closing and read-only."
              : currentSession?.status === "failed"
                ? "This session failed and is read-only."
                : "This session is closed and read-only.");

  useEffect(() => {
    if (!onInspectorDataChange) return;
    onInspectorDataChange({
      events,
      artifacts,
      session: currentSession,
      usage: sessionUsage,
    });
  }, [onInspectorDataChange, events, artifacts, currentSession, sessionUsage]);

  if (mode === "canvas") {
    return (
      <div className="flex-1 flex overflow-hidden min-h-0 min-w-0 relative select-text bg-[var(--bg-canvas)]">
        <ChatArea
          messages={messages}
          isRunning={isRunning}
          isLoading={isLoadingHistory}
          isClosed={isClosed}
          closedReason={resolvedClosedReason}
          onSendMessage={handleSendMessage}
          onInterrupt={handleInterrupt}
        />
      </div>
    );
  }

  if (mode === "embedded") {
    const idToCopy = taskExecution?.executionId ?? sessionId;
    const hitRate = sessionUsage ? calculateCacheHitRate(sessionUsage) : null;

    return (
      <div className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden bg-[var(--bg-canvas)] select-text">
        {/* Compact Run Meta + Sub-tabs Bar (matches TaskExecutionDetail 1:1) */}
        <div className="px-5 py-2.5 border-b border-[var(--border-default)] bg-[var(--bg-surface)] shrink-0 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-xs">
            <div className="flex flex-wrap items-center gap-2 min-w-0">
              {taskExecution && (
                <span
                  className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[var(--radius-xs)] text-[10px] font-semibold border uppercase ${
                    taskExecution.status === "success"
                      ? "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/20"
                      : "text-red-600 dark:text-red-400 bg-red-500/10 border-red-500/20"
                  }`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      taskExecution.status === "success" ? "bg-emerald-500" : "bg-red-500"
                    }`}
                  />
                  {taskExecution.status}
                </span>
              )}

              <button
                type="button"
                onClick={async () => {
                  const ok = await copyToClipboard(idToCopy);
                  if (ok) {
                    setCopiedId(true);
                    setTimeout(() => setCopiedId(false), 1600);
                    toast.success("已复制 ID");
                  }
                }}
                title={`点击复制 ${idToCopy}`}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[var(--radius-xs)] bg-[var(--bg-canvas)] border border-[var(--border-default)] text-[10.5px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-strong)] transition-colors cursor-pointer"
              >
                <span>{idToCopy.slice(0, 18)}...</span>
                {copiedId ? (
                  <Check className="w-3 h-3 text-emerald-500" />
                ) : (
                  <Copy className="w-3 h-3 opacity-60" />
                )}
              </button>

              {taskExecution && (
                <span className="inline-flex items-center gap-1 text-[10.5px] text-[var(--text-muted)]">
                  <Clock className="w-3 h-3" />
                  <span>{formatDuration(taskExecution.durationMs)}</span>
                </span>
              )}

              {taskExecution?.startedAt && (
                <span className="text-[10.5px] text-[var(--text-muted)] hidden lg:inline">
                  {formatDateTime(taskExecution.startedAt)}
                </span>
              )}
            </div>

            {/* Clean inline view tabs */}
            <div className="flex items-center gap-0.5 bg-[var(--bg-canvas)] p-0.5 rounded-[var(--radius-sm)] border border-[var(--border-default)] text-[10.5px]">
              <button
                type="button"
                onClick={() => setEmbeddedTab("chat")}
                className={`px-2 py-0.5 rounded-[var(--radius-xs)] transition-colors cursor-pointer inline-flex items-center gap-1 ${
                  embeddedTab === "chat"
                    ? "bg-[var(--primary)] text-[var(--text-inverted)] font-medium"
                    : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                }`}
              >
                <MessageSquare className="w-3 h-3" />
                <span>对话</span>
              </button>
              <button
                type="button"
                onClick={() => setEmbeddedTab("events")}
                className={`px-2 py-0.5 rounded-[var(--radius-xs)] transition-colors cursor-pointer inline-flex items-center gap-1 ${
                  embeddedTab === "events"
                    ? "bg-[var(--primary)] text-[var(--text-inverted)] font-medium"
                    : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                }`}
              >
                <Activity className="w-3 h-3" />
                <span>事件 ({events.length})</span>
              </button>
              <button
                type="button"
                onClick={() => setEmbeddedTab("artifacts")}
                className={`px-2 py-0.5 rounded-[var(--radius-xs)] transition-colors cursor-pointer inline-flex items-center gap-1 ${
                  embeddedTab === "artifacts"
                    ? "bg-[var(--primary)] text-[var(--text-inverted)] font-medium"
                    : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                }`}
              >
                <FileCode className="w-3 h-3" />
                <span>产物 ({visibleArtifacts.length})</span>
              </button>
              <button
                type="button"
                onClick={() => setEmbeddedTab("info")}
                className={`px-2 py-0.5 rounded-[var(--radius-xs)] transition-colors cursor-pointer inline-flex items-center gap-1 ${
                  embeddedTab === "info"
                    ? "bg-[var(--primary)] text-[var(--text-inverted)] font-medium"
                    : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                }`}
              >
                <Info className="w-3 h-3" />
                <span>状态与用量</span>
              </button>
            </div>
          </div>

          {taskExecution?.errorMessage && (
            <div className="flex items-start gap-2 px-3 py-1.5 rounded-[var(--radius-sm)] border border-red-500/30 bg-red-500/10 text-[11px] text-red-600 dark:text-red-400 font-mono">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-red-500" />
              <span className="break-words leading-relaxed">{taskExecution.errorMessage}</span>
            </div>
          )}
        </div>

        {/* Embedded Tab Content */}
        <div className="flex-1 flex min-h-0 overflow-hidden bg-[var(--bg-canvas)]">
          {embeddedTab === "chat" && (
            <ChatArea
              messages={messages}
              isRunning={isRunning}
              isLoading={isLoadingHistory}
              isClosed={isClosed}
              closedReason={resolvedClosedReason}
              embedded
              onSendMessage={handleSendMessage}
              onInterrupt={handleInterrupt}
            />
          )}

          {embeddedTab === "events" && (
            <m.div
              key="embedded-events"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.14, ease: EASE_OUT_EXPO }}
              className="flex-1 flex flex-col min-h-0 p-5"
            >
              <div className="flex-1 flex flex-col min-h-0 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] overflow-hidden">
                <div className="px-4 py-2 border-b border-[var(--border-default)] bg-[var(--bg-table-header)] shrink-0">
                  <div className="relative max-w-sm">
                    <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
                    <input
                      type="text"
                      value={eventFilter}
                      onChange={(e) => setEventFilter(e.target.value)}
                      placeholder="按事件类型过滤..."
                      className="w-full pl-8 pr-3 py-1 rounded-[var(--radius-sm)] text-xs font-mono bg-[var(--bg-input)] border border-[var(--border-default)] text-[var(--text-primary)] outline-hidden focus:border-[var(--border-focus)]"
                    />
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto p-3 space-y-1.5 font-mono text-[11px] bg-[var(--bg-code)]">
                  {filteredEvents.length === 0 ? (
                    <div className="text-center py-10 text-[var(--text-muted)]">暂无匹配事件</div>
                  ) : (
                    filteredEvents.map((evt, idx) => {
                      const isExpanded = !!expandedEvents[idx];
                      const hasOpened = idx in expandedEvents;
                      return (
                        <div
                          key={evt.id || idx}
                          className="border border-[var(--border-default)] rounded-[var(--radius-sm)] bg-[var(--bg-surface)] p-2.5"
                        >
                          <div
                            className="flex items-center justify-between cursor-pointer select-none"
                            onClick={() =>
                              setExpandedEvents((prev) => ({ ...prev, [idx]: !prev[idx] }))
                            }
                          >
                            <div className="flex items-center gap-1.5 truncate">
                              <ChevronRight
                                className={`w-3 h-3 text-[var(--text-muted)] shrink-0 transition-transform duration-150 ${
                                  isExpanded ? "rotate-90" : ""
                                }`}
                              />
                              <span className="font-semibold text-[var(--text-primary)] truncate">
                                {evt.type}
                              </span>
                            </div>
                            <span className="text-[10px] text-[var(--text-muted)]">
                              #{evt.sequence ?? idx + 1}
                            </span>
                          </div>
                          <div className="collapsible-grid" data-open={isExpanded}>
                            <div className="collapsible-inner">
                              {hasOpened && (
                                <div className="mt-2 pt-2 border-t border-[var(--border-subtle)]">
                                  <pre className="text-[10.5px] bg-[var(--bg-code)] p-2.5 rounded overflow-x-auto text-[var(--text-code)] max-h-56">
                                    {JSON.stringify(evt.payload || {}, null, 2)}
                                  </pre>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </m.div>
          )}

          {embeddedTab === "artifacts" && (
            <m.div
              key="embedded-artifacts"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.14, ease: EASE_OUT_EXPO }}
              className="flex-1 overflow-y-auto p-5"
            >
              <div className="w-full space-y-2.5">
                {visibleArtifacts.length === 0 ? (
                  <div className="text-center py-10 text-xs font-mono text-[var(--text-muted)]">
                    本次执行暂无生成产物
                  </div>
                ) : (
                  visibleArtifacts.map((art) => (
                    <div
                      key={art.id}
                      className="border border-[var(--border-default)] rounded-[var(--radius-md)] bg-[var(--bg-surface)] p-3.5 flex items-center justify-between gap-2"
                    >
                      <div className="truncate">
                        <div className="font-semibold text-xs text-[var(--text-primary)] truncate">
                          {art.path.split("/").pop()}
                        </div>
                        <div className="text-[10.5px] text-[var(--text-muted)] font-mono">
                          {(art.sizeBytes / 1024).toFixed(1)} KB | {art.contentType}
                        </div>
                      </div>
                      <a
                        href={sessionsApi.getArtifactDownloadUrl(art.sessionId, art.id)}
                        target="_blank"
                        rel="noreferrer"
                        className="p-1.5 rounded bg-[var(--bg-surface-elevated)] hover:bg-[var(--bg-surface-hover)] border border-[var(--border-default)] text-[var(--text-secondary)]"
                        title="查看/下载产物"
                      >
                        <Download className="w-3.5 h-3.5" />
                      </a>
                    </div>
                  ))
                )}
              </div>
            </m.div>
          )}

          {embeddedTab === "info" && (
            <m.div
              key="embedded-info"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.14, ease: EASE_OUT_EXPO }}
              className="flex-1 overflow-y-auto p-5 font-mono text-xs"
            >
              <div className="w-full space-y-4">
                {/* Session & Model Usage */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] overflow-hidden text-[11px]">
                    <div className="px-4 py-2 border-b border-[var(--border-default)] bg-[var(--bg-table-header)] text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                      会话运行信息
                    </div>
                    <div className="p-4 space-y-1.5">
                      <div>
                        <span className="text-[var(--text-muted)]">Session: </span>
                        <span className="text-[var(--text-primary)] break-all">{sessionId}</span>
                      </div>
                      {currentSession?.runtime && (
                        <div>
                          <span className="text-[var(--text-muted)]">Runtime: </span>
                          <span className="text-[var(--text-primary)]">{currentSession.runtime}</span>
                        </div>
                      )}
                      {currentSession?.model && (
                        <div>
                          <span className="text-[var(--text-muted)]">Model: </span>
                          <span className="text-[var(--text-primary)]">{currentSession.model}</span>
                        </div>
                      )}
                      {currentSession?.reasoningEffort && (
                        <div>
                          <span className="text-[var(--text-muted)]">Effort: </span>
                          <span className="text-[var(--text-primary)]">
                            {currentSession.reasoningEffort}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] overflow-hidden text-[11px]">
                    <div className="px-4 py-2 border-b border-[var(--border-default)] bg-[var(--bg-table-header)] text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                      模型用量 (Usage)
                    </div>
                    <div className="p-4 space-y-1.5">
                      {sessionUsage ? (
                        <>
                          <div className="flex justify-between">
                            <span className="text-[var(--text-muted)]">总计</span>
                            <span className="text-[var(--text-primary)] font-semibold">
                              {formatTokenCount(sessionUsage.totalTokens)} ({sessionUsage.turnCount}{" "}
                              轮)
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-[var(--text-muted)]">新输入 / 输出</span>
                            <span className="text-[var(--text-primary)]">
                              {formatTokenCount(sessionUsage.inputTokens)} /{" "}
                              {formatTokenCount(sessionUsage.outputTokens)}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-[var(--text-muted)]">缓存读</span>
                            <span className="text-emerald-600 dark:text-emerald-400">
                              {formatTokenCount(sessionUsage.cacheReadTokens)}
                              {hitRate !== null ? ` (${hitRate}%)` : ""}
                            </span>
                          </div>
                        </>
                      ) : (
                        <div className="text-[var(--text-muted)]">暂无用量记录</div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Task State Snapshot */}
                {taskExecution && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] overflow-hidden">
                      <div className="px-4 py-2 border-b border-[var(--border-default)] bg-[var(--bg-table-header)] text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                        stateBefore
                      </div>
                      <pre className="p-4 bg-[var(--bg-code)] text-[11px] text-[var(--text-code)] overflow-x-auto max-h-60 leading-relaxed">
                        {JSON.stringify(taskExecution.stateBefore || {}, null, 2)}
                      </pre>
                    </div>
                    <div className="rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] overflow-hidden">
                      <div className="px-4 py-2 border-b border-[var(--border-default)] bg-[var(--bg-table-header)] text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                        stateAfter
                      </div>
                      <pre className="p-4 bg-[var(--bg-code)] text-[11px] text-[var(--text-code)] overflow-x-auto max-h-60 leading-relaxed">
                        {JSON.stringify(taskExecution.stateAfter || {}, null, 2)}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            </m.div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex overflow-hidden min-h-0 relative select-text bg-[var(--bg-canvas)]">
      <ChatArea
        messages={messages}
        isRunning={isRunning}
        isLoading={isLoadingHistory}
        isClosed={isClosed}
        closedReason={resolvedClosedReason}
        onSendMessage={handleSendMessage}
        onInterrupt={handleInterrupt}
      />

      {/* Collapsible Inspector Drawer (Standalone Sessions Mode) */}
      <AnimatePresence initial={false}>
        {showInspector && (
          <m.div
            key="inspector-drawer"
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 24 }}
            transition={{ duration: 0.18, ease: EASE_OUT_EXPO }}
            className="w-[var(--inspector-width)] border-l border-[var(--border-default)] bg-[var(--bg-inspector)] flex flex-col shrink-0 overflow-hidden"
          >
            <Inspector
              events={events}
              artifacts={artifacts}
              session={currentSession}
              project={activeProject}
              usage={sessionUsage}
              taskExecution={taskExecution}
            />
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}
