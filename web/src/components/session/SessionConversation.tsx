import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import {
  fetchArtifacts,
  fetchSessionEvents,
  fetchSessions,
  getSession,
  interruptTurn,
  postTurn,
  subscribeEvents,
} from "../../api/client";
import { useStudio } from "../../context/StudioContext";
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

export interface SessionConversationProps {
  sessionId: string;
  /** Force read-only mode (disables message composer & interrupt, e.g. for task execution playback). */
  readOnly?: boolean;
  /** Custom read-only banner shown at the bottom when `readOnly` is true. */
  readOnlyReason?: string;
  /**
   * "standalone" (default, Sessions page): ChatArea + collapsible right Inspector drawer.
   * "embedded" (Tasks Studio): inline top execution bar with Chat / Events / Artifacts / Info tabs.
   */
  mode?: "standalone" | "embedded";
  /** Optional task execution metadata shown in embedded mode or Inspector. */
  taskExecution?: TaskExecutionRecord | null;
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
}: SessionConversationProps) {
  const {
    activeProjectId,
    activeProject,
    activeSession,
    setSessions,
    showInspector,
  } = useStudio();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>([]);
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [loadedSessionId, setLoadedSessionId] = useState<string | null>(null);
  const [sessionDetail, setSessionDetail] = useState<SessionRoute | null>(null);
  const [sessionUsage, setSessionUsage] = useState<SessionUsageSummary | null>(null);
  const [sessionNotFound, setSessionNotFound] = useState(false);

  const isLoadingHistory = loadedSessionId !== sessionId;

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

  useEffect(() => {
    let active = true;
    setSessionNotFound(false);
    setSessionDetail(null);
    setSessionUsage(null);
    getSession(sessionId)
      .then((data) => {
        if (!active) return;
        setSessionDetail(data.session);
        setSessionUsage(data.usage ?? null);
      })
      .catch((err) => {
        if (!active) return;
        console.warn("Session not found or error loading session info:", err);
        setSessionNotFound(true);
      });
    return () => {
      active = false;
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

      setEvents((prev) => [...prev, evt]);

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
          setSessionUsage((prev) => mergeTurnUsageIntoSummary(prev, turnUsage));
        }
        fetchArtifacts(sessionId).then(setArtifacts);
        if (!readOnly) {
          fetchSessions(activeProjectId || undefined).then(setSessions);
        }
      } else if (evt.type === "session.closed" || evt.type === "session.archived") {
        flushEventBuffer();
        const nextStatus = evt.type === "session.closed" ? "closed" : "archived";
        setSessionDetail((prev) => (prev ? { ...prev, status: nextStatus } : null));
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
          fetchArtifacts(sessionId).then(setArtifacts);
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
    [sessionId, activeProjectId, readOnly, setSessions, flushEventBuffer],
  );

  useEffect(() => {
    let isMounted = true;
    lastSequenceRef.current = 0;

    if (unsubscribeRef.current) {
      unsubscribeRef.current();
      unsubscribeRef.current = null;
    }
    eventBufferRef.current = [];
    if (throttleTimerRef.current) {
      clearTimeout(throttleTimerRef.current);
      throttleTimerRef.current = null;
    }

    setMessages([]);
    setEvents([]);
    setArtifacts([]);
    setIsRunning(false);

    fetchArtifacts(sessionId).then((arts) => {
      if (isMounted) setArtifacts(arts);
    });

    fetchSessionEvents(sessionId)
      .then((history) => {
        if (!isMounted) return;
        setEvents(history);
        const { messages: parsed, isRunning: running } =
          reconstructMessagesFromEvents(history);
        setMessages(parsed);
        setIsRunning(running);
        setLoadedSessionId(sessionId);

        const maxSeq = history.reduce((max, e) => Math.max(max, e.sequence ?? 0), 0);
        lastSequenceRef.current = maxSeq;

        const alreadyEnded = history.some(
          (e) => e.type === "session.closed" || e.type === "session.archived",
        );
        if (!alreadyEnded) {
          unsubscribeRef.current = subscribeEvents(
            sessionId,
            handleEvent,
            (err) => console.warn("SSE connection state change / reconnecting:", err),
            maxSeq,
          );
        }
      })
      .catch((err) => {
        if (!isMounted) return;
        console.error("Failed to load session events:", err);
        setLoadedSessionId(sessionId);
      });

    return () => {
      isMounted = false;
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
      eventBufferRef.current = [];
      if (throttleTimerRef.current) {
        clearTimeout(throttleTimerRef.current);
        throttleTimerRef.current = null;
      }
    };
  }, [sessionId, handleEvent]);

  const handleSendMessage = async (text: string): Promise<boolean> => {
    if (!text.trim() || isRunning) return false;
    if (isClosed) {
      toast.error("Session is read-only");
      return false;
    }

    try {
      const res = await postTurn(sessionId, text);
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
        setSessionDetail((prev) => (prev ? { ...prev, status: "archived" } : null));
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
      await interruptTurn(sessionId);
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

  if (mode === "embedded") {
    const idToCopy = taskExecution?.executionId ?? sessionId;
    const hitRate = sessionUsage ? calculateCacheHitRate(sessionUsage) : null;

    return (
      <div className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden bg-[var(--bg-canvas)] select-text">
        {/* Compact Run Meta + Sub-tabs Bar (matches TaskExecutionDetail 1:1) */}
        <div className="px-4 py-2 border-b border-[var(--border-default)] bg-[var(--bg-surface)] shrink-0 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-xs">
            <div className="flex flex-wrap items-center gap-2 min-w-0">
              {taskExecution && (
                <span
                  className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[var(--radius-xs)] text-[10px] font-semibold border uppercase ${
                    taskExecution.status === "success"
                      ? "text-emerald-500 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/20"
                      : "text-red-500 dark:text-red-400 bg-red-500/10 border-red-500/20"
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
            <div className="flex items-start gap-2 px-3 py-1.5 rounded-[var(--radius-sm)] border border-red-500/30 bg-red-500/10 text-[11px] text-red-400 font-mono">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-red-500" />
              <span className="break-words leading-relaxed">{taskExecution.errorMessage}</span>
            </div>
          )}
        </div>

        {/* Embedded Tab Content */}
        <div className="flex-1 flex min-h-0 overflow-hidden">
          {embeddedTab === "chat" && (
            <ChatArea
              messages={messages}
              isRunning={isRunning}
              isLoading={isLoadingHistory}
              isClosed={isClosed}
              closedReason={resolvedClosedReason}
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
              className="flex-1 flex flex-col min-h-0"
            >
              <div className="px-4 py-2 border-b border-[var(--border-default)] bg-[var(--bg-canvas)] shrink-0">
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
              <div className="flex-1 overflow-y-auto p-4 space-y-1.5 font-mono text-[11px]">
                {filteredEvents.length === 0 ? (
                  <div className="text-center py-10 text-[var(--text-muted)]">暂无匹配事件</div>
                ) : (
                  filteredEvents.map((evt, idx) => {
                    const isExpanded = !!expandedEvents[idx];
                    const hasOpened = idx in expandedEvents;
                    return (
                      <div
                        key={evt.id || idx}
                        className="border border-[var(--border-subtle)] rounded-[var(--radius-sm)] bg-[var(--bg-surface)] p-2"
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
                                <pre className="text-[10.5px] bg-[var(--bg-code)] p-2 rounded overflow-x-auto text-[var(--text-code)] max-h-56">
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
              <div className="max-w-3xl mx-auto space-y-2">
                {visibleArtifacts.length === 0 ? (
                  <div className="text-center py-10 text-xs font-mono text-[var(--text-muted)]">
                    本次执行暂无生成产物
                  </div>
                ) : (
                  visibleArtifacts.map((art) => (
                    <div
                      key={art.id}
                      className="border border-[var(--border-default)] rounded-[var(--radius-md)] bg-[var(--bg-surface)] p-3 flex items-center justify-between gap-2"
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
                        href={`/sessions/${encodeURIComponent(art.sessionId)}/artifacts/${encodeURIComponent(art.id)}`}
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
              <div className="max-w-3xl mx-auto space-y-5">
                {/* Session & Model Usage */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="p-3.5 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] space-y-1.5 text-[11px]">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">
                      会话运行信息
                    </div>
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

                  <div className="p-3.5 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] space-y-1.5 text-[11px]">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">
                      模型用量 (Usage)
                    </div>
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
                          <span className="text-emerald-500">
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

                {/* Task State Snapshot */}
                {taskExecution && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1.5">
                        stateBefore
                      </div>
                      <pre className="p-3 rounded-[var(--radius-sm)] bg-[var(--bg-code)] border border-[var(--border-default)] text-[11px] text-[var(--text-code)] overflow-x-auto max-h-60">
                        {JSON.stringify(taskExecution.stateBefore || {}, null, 2)}
                      </pre>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1.5">
                        stateAfter
                      </div>
                      <pre className="p-3 rounded-[var(--radius-sm)] bg-[var(--bg-code)] border border-[var(--border-default)] text-[11px] text-[var(--text-code)] overflow-x-auto max-h-60">
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
