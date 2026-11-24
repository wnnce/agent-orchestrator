import React, { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, m } from "motion/react";
import { toast } from "sonner";
import { EASE_OUT_EXPO } from "../../utils/motion";
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
} from "../../types";
import { mergeTurnUsageIntoSummary } from "../../utils/formatters";
import {
  applyEventToAssistantMessage,
  parseTurnUsage,
  reconstructMessagesFromEvents,
} from "../../utils/messageParser";
import { ChatArea } from "../ChatArea";
import { Inspector } from "../Inspector";
import { SessionBoard } from "../workspace/SessionBoard";

function SessionConversationView({ sessionId }: { sessionId: string }) {
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
  const [sessionDetail, setSessionDetail] = useState<SessionRoute | null>(null);
  const [sessionUsage, setSessionUsage] = useState<SessionUsageSummary | null>(null);
  const [sessionNotFound, setSessionNotFound] = useState(false);

  const unsubscribeRef = useRef<(() => void) | null>(null);
  const artifactDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const eventBufferRef = useRef<RuntimeEvent[]>([]);
  const throttleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSequenceRef = useRef<number>(0);

  // Batch flush buffered streaming events to avoid per-token React re-renders
  const flushEventBuffer = useCallback(() => {
    if (throttleTimerRef.current) {
      clearTimeout(throttleTimerRef.current);
      throttleTimerRef.current = null;
    }
    const buffered = eventBufferRef.current;
    if (buffered.length === 0) return;
    eventBufferRef.current = [];

    setMessages((prev) => {
      const idx = prev.findLastIndex((m) => m.role === "assistant");
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

  // Load session detail and check if it's archived/deleted/closed
  useEffect(() => {
    setSessionNotFound(false);
    setSessionUsage(null);
    getSession(sessionId)
      .then((data) => {
        setSessionDetail(data.session);
        setSessionUsage(data.usage ?? null);
      })
      .catch((err) => {
        console.warn("Session not found or error loading session info:", err);
        setSessionNotFound(true);
      });
  }, [sessionId]);

  // Determine if session is in a closed / archived / read-only terminal state
  const currentSession = sessionDetail || activeSession;
  const isClosed = Boolean(
    sessionNotFound ||
    currentSession?.status === "archived" ||
    currentSession?.status === "closing" ||
    currentSession?.status === "failed" ||
    (currentSession?.deletedAt && currentSession.deletedAt > 0) ||
    events.some((e) => e.type === "session.closed" || e.type === "session.archived")
  );

  // SSE handler
  const handleEvent = useCallback(
    (evt: RuntimeEvent) => {
      // Discard duplicate events that were already loaded in history or processed
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
          const idx = prev.findLastIndex((m) => m.role === "assistant");
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
        fetchSessions(activeProjectId || undefined).then(setSessions);
      } else if (evt.type === "session.closed" || evt.type === "session.archived") {
        flushEventBuffer();
        setSessionDetail((prev) => (prev ? { ...prev, status: "archived" } : null));
        setSessions((prev) =>
          prev.map((s) => (s.sessionId === sessionId ? { ...s, status: "archived" } : s))
        );
        setIsRunning(false);
        toast.info("Session has been closed / archived");
      } else if (evt.type === "artifact.created") {
        if (artifactDebounceTimerRef.current) clearTimeout(artifactDebounceTimerRef.current);
        artifactDebounceTimerRef.current = setTimeout(() => {
          fetchArtifacts(sessionId).then(setArtifacts);
        }, 150);
      } else if (evt.type === "session.runtime_reset") {
        toast.warning("运行时会话已重置，Agent 不再保留之前的对话上下文");
      } else if (evt.type === "session.renamed" && evt.payload?.title) {
        const newTitle = evt.payload.title;
        setSessions((prev) =>
          prev.map((s) => (s.sessionId === sessionId ? { ...s, title: newTitle } : s))
        );
      } else {
        // High-frequency streaming events (delta, thinking, command output): buffer and flush within 80ms window
        eventBufferRef.current.push(evt);
        if (!throttleTimerRef.current) {
          throttleTimerRef.current = setTimeout(() => {
            throttleTimerRef.current = null;
            flushEventBuffer();
          }, 80);
        }
      }
    },
    [sessionId, activeProjectId, setSessions, flushEventBuffer],
  );

  // Load history when session changes, then establish SSE subscription starting after maxSeq
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

        // Find max sequence from historical events
        const maxSeq = history.reduce((max, e) => Math.max(max, e.sequence ?? 0), 0);
        lastSequenceRef.current = maxSeq;

        // ONLY establish SSE connection after historical data is fetched and messages are ready
        unsubscribeRef.current = subscribeEvents(
          sessionId,
          handleEvent,
          (err) => console.warn("SSE connection state change / reconnecting:", err),
          maxSeq,
        );
      })
      .catch((err) => {
        if (!isMounted) return;
        console.error("Failed to load session events:", err);
        unsubscribeRef.current = subscribeEvents(
          sessionId,
          handleEvent,
          (err) => console.warn("SSE connection state change / reconnecting:", err),
        );
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

  // Turn Actions (Validated Server-Response Pattern with Anti-Duplicate Debouncing)
  const handleSendMessage = async (text: string): Promise<boolean> => {
    if (!text.trim() || isRunning) return false;
    if (isClosed) {
      toast.error("Session is closed and read-only");
      return false;
    }

    try {
      const res = await postTurn(sessionId, text);
      const turn = res?.turn;

      // Confirmed accepted by server: insert user message with verified turnId and timestamp
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

      // If backend indicates session is closed or not found, update state immediately
      if (
        errMsg.includes("archived") ||
        errMsg.includes("closing") ||
        errMsg.includes("read-only") ||
        errMsg.includes("session_not_found")
      ) {
        setSessionDetail((prev) => (prev ? { ...prev, status: "archived" } : null));
        setSessions((prev) =>
          prev.map((s) => (s.sessionId === sessionId ? { ...s, status: "archived" } : s))
        );
      }
      return false;
    }
  };

  const handleInterrupt = async () => {
    try {
      await interruptTurn(sessionId);
      setIsRunning(false);
      setMessages((prev) => {
        const idx = prev.findLastIndex((m) => m.role === "assistant");
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

  return (
    <div className="flex-1 flex overflow-hidden min-h-0 relative select-text bg-[var(--bg-canvas)]">
      <ChatArea
        messages={messages}
        isRunning={isRunning}
        isClosed={isClosed}
        closedReason={
          sessionNotFound
            ? "This session no longer exists or has been deleted."
            : currentSession?.status === "archived"
              ? "This session is archived and read-only."
              : currentSession?.status === "closing"
                ? "This session is closing and read-only."
                : currentSession?.status === "failed"
                  ? "This session failed and is read-only."
                  : "This session is closed and read-only."
        }
        onSendMessage={handleSendMessage}
        onInterrupt={handleInterrupt}
      />

      {/* Collapsible Inspector Drawer */}
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
            />
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function SessionsView() {
  const { activeSessionId } = useStudio();

  if (!activeSessionId) {
    return <SessionBoard />;
  }

  return <SessionConversationView sessionId={activeSessionId} />;
}
