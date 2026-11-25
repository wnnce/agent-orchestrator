import React, { useState, useRef, useEffect, useCallback } from "react";
import { AnimatePresence, m } from "motion/react";
import {
  Square,
  ChevronDown,
  ChevronRight,
  Terminal,
  Wrench,
  ArrowUp,
  Sparkles,
  User,
  Archive,
  Loader2,
  AlertCircle,
  MessageSquare,
} from "lucide-react";
import type { ChatMessage } from "../types";
import { calculateCacheHitRate, formatTokenCount } from "../utils/formatters";
import { SPRING_SNAPPY } from "../utils/motion";
import { MarkdownRenderer } from "./common/MarkdownRenderer";

interface ChatAreaProps {
  messages: ChatMessage[];
  isRunning: boolean;
  isLoading?: boolean;
  onSendMessage: (text: string) => Promise<boolean> | void;
  onInterrupt: () => void;
  isClosed?: boolean;
  closedReason?: string;
  embedded?: boolean;
}

export const ChatArea: React.FC<ChatAreaProps> = ({
  messages,
  isRunning,
  isLoading = false,
  onSendMessage,
  onInterrupt,
  isClosed = false,
  closedReason,
  embedded = false,
}) => {
  const [input, setInput] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const [showScrollBottomBtn, setShowScrollBottomBtn] = useState(false);
  const scrollThrottleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastScrollTimeRef = useRef<number>(0);
  const [collapsedReasoning, setCollapsedReasoning] = useState<Record<string, boolean>>({});
  const [collapsedThinking, setCollapsedThinking] = useState<Record<string, boolean>>({});
  const [collapsedCommands, setCollapsedCommands] = useState<Record<string, boolean>>({});
  const [collapsedTools, setCollapsedTools] = useState<Record<string, boolean>>({});
  const [expandedUsage, setExpandedUsage] = useState<Record<string, boolean>>({});

  const toggleUsage = (id: string) => {
    setExpandedUsage((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const toggleTool = (id: string) => {
    setCollapsedTools((prev) => ({ ...prev, [id]: !(prev[id] ?? true) }));
  };

  // Cleanup scroll throttle timer on unmount
  useEffect(() => {
    return () => {
      if (scrollThrottleTimerRef.current) {
        clearTimeout(scrollThrottleTimerRef.current);
      }
    };
  }, []);

  // IME Composition state tracking for Chinese/Japanese/Korean input methods
  const isComposingRef = useRef(false);
  const lastCompositionEndTimeRef = useRef(0);

  // Auto-resize textarea dynamically based on scrollHeight
  const adjustTextareaHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const minHeight = 44;
    const maxHeight = 200;
    const scrollHeight = textarea.scrollHeight;
    const targetHeight = Math.min(Math.max(scrollHeight, minHeight), maxHeight);
    textarea.style.height = `${targetHeight}px`;
  }, []);

  useEffect(() => {
    adjustTextareaHeight();
  }, [input, adjustTextareaHeight]);

  // Check whether scroll position is near bottom
  const updateScrollState = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const { scrollTop, scrollHeight, clientHeight } = container;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

    // Threshold: if within 80px from the bottom, keep auto-scrolling pinned
    const atBottom = distanceFromBottom <= 80;
    shouldAutoScrollRef.current = atBottom;

    // Display "scroll to bottom" button when user actively scrolls up (> 120px)
    setShowScrollBottomBtn(distanceFromBottom > 120);
  }, []);

  // Throttled scroll handler (~60ms) with leading and trailing execution
  const handleScroll = useCallback(() => {
    const now = Date.now();
    const remaining = 60 - (now - lastScrollTimeRef.current);

    if (remaining <= 0) {
      if (scrollThrottleTimerRef.current) {
        clearTimeout(scrollThrottleTimerRef.current);
        scrollThrottleTimerRef.current = null;
      }
      lastScrollTimeRef.current = now;
      updateScrollState();
    } else if (!scrollThrottleTimerRef.current) {
      scrollThrottleTimerRef.current = setTimeout(() => {
        lastScrollTimeRef.current = Date.now();
        scrollThrottleTimerRef.current = null;
        updateScrollState();
      }, remaining);
    }
  }, [updateScrollState]);

  // Smart auto-scroll: follow stream only if pinned to bottom or not manually scrolling up
  useEffect(() => {
    if (shouldAutoScrollRef.current && scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
    }
  }, [messages]);

  const scrollToBottom = () => {
    shouldAutoScrollRef.current = true;
    setShowScrollBottomBtn(false);
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTo({
        top: scrollContainerRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
  };

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!input.trim() || isRunning || isSubmitting || isClosed) return;
    const textToSend = input.trim();
    setIsSubmitting(true);

    try {
      const result = onSendMessage(textToSend);
      const ok = result instanceof Promise ? await result : true;
      if (ok) {
        setInput("");
        if (textareaRef.current) {
          textareaRef.current.style.height = "44px";
        }

        // Always snap down when the user sends a new message
        shouldAutoScrollRef.current = true;
        setShowScrollBottomBtn(false);
        setTimeout(() => {
          if (scrollContainerRef.current) {
            scrollContainerRef.current.scrollTo({
              top: scrollContainerRef.current.scrollHeight,
              behavior: "smooth",
            });
          }
        }, 30);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCompositionStart = () => {
    isComposingRef.current = true;
  };

  const handleCompositionEnd = () => {
    isComposingRef.current = false;
    lastCompositionEndTimeRef.current = Date.now();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      if (
        isComposingRef.current ||
        e.nativeEvent.isComposing ||
        e.keyCode === 229 ||
        Date.now() - lastCompositionEndTimeRef.current < 100
      ) {
        return;
      }
      e.preventDefault();
      handleSubmit();
    }
  };

  const toggleReasoning = (id: string) => {
    setCollapsedReasoning((prev) => ({
      ...prev,
      [id]: !(prev[id] ?? true),
    }));
  };

  const toggleThinking = (id: string) => {
    setCollapsedThinking((prev) => ({
      ...prev,
      [id]: !(prev[id] ?? true),
    }));
  };

  const toggleCommand = (id: string) => {
    setCollapsedCommands((prev) => ({
      ...prev,
      [id]: !(prev[id] ?? true),
    }));
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-[var(--bg-canvas)] select-text relative">
      {/* Messages Scroll Area */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className={
          embedded
            ? `flex-1 overflow-y-auto p-5 ${isClosed ? "pb-20" : "pb-44"} space-y-6`
            : "flex-1 overflow-y-auto px-4 md:px-8 pt-8 pb-48 space-y-8"
        }
      >
        {isLoading ? (
          <div className="h-full flex items-center justify-center gap-2 text-xs font-mono text-[var(--text-muted)] select-none pb-12 animate-delayed-fade">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>Loading conversation...</span>
          </div>
        ) : messages.length === 0 ? (
          isClosed ? (
            <div className="h-full flex flex-col items-center justify-center gap-2 px-4 select-none pb-12 text-center font-mono">
              <div className="w-10 h-10 rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] flex items-center justify-center text-[var(--text-muted)]">
                <MessageSquare className="w-4 h-4 opacity-60" />
              </div>
              <div className="text-xs text-[var(--text-muted)]">暂无对话消息记录</div>
            </div>
          ) : (
            <div className="h-full flex flex-col items-center justify-center px-4 select-none pb-12">
              <div className="w-12 h-12 rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface-elevated)] flex items-center justify-center mb-4 text-[var(--text-primary)] shadow-sm">
                <Sparkles className="w-5 h-5 text-[var(--text-secondary)]" />
              </div>
              <h2 className="text-lg font-semibold tracking-tight text-[var(--text-primary)] mb-1">
                How can I help you today?
              </h2>
              <p className="text-xs text-[var(--text-muted)] mb-6 text-center max-w-sm leading-relaxed">
                Ask questions, execute tasks, inspect files, or modify code in this workspace.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 w-full max-w-lg">
                {[
                  { label: "Check project status", desc: "Run health checks and view recent logs" },
                  { label: "Inspect modified files", desc: "Review git diff and working tree changes" },
                  { label: "Run test suite", desc: "Execute automated tests and inspect results" },
                  { label: "Explain project architecture", desc: "Overview of components, services and flow" },
                ].map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    onClick={() => {
                      setInput(item.label);
                      textareaRef.current?.focus();
                    }}
                    className="p-3 text-left rounded-xl border border-[var(--border-default)] hover:border-[var(--border-strong)] bg-[var(--bg-surface)] hover:bg-[var(--bg-surface-hover)] hover:-translate-y-0.5 active:scale-[0.99] transition-all duration-150 cursor-pointer group"
                  >
                    <div className="text-xs font-medium text-[var(--text-primary)]">
                      {item.label}
                    </div>
                    <div className="text-[11px] text-[var(--text-muted)] mt-0.5">
                      {item.desc}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )
        ) : (
          messages.map((msg) => {
            const isUser = msg.role === "user";

            return (
              <div
                key={msg.id}
                className={
                  embedded
                    ? "w-full animate-msg-enter"
                    : "max-w-3xl mx-auto w-full animate-msg-enter"
                }
              >
                {isUser ? (
                  /* User Message: Aligned strictly on the shared left axis without boxy card */
                  <div className="w-full space-y-2">
                    <div className="flex items-center gap-2 font-mono text-[11px] text-[var(--text-muted)] select-none">
                      <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-[var(--bg-surface-elevated)] border border-[var(--border-default)] text-[10px] font-semibold text-[var(--text-primary)]">
                        <User className="w-3 h-3 text-[var(--text-secondary)]" />
                      </span>
                      <span className="font-semibold text-xs text-[var(--text-primary)] font-sans">
                        You
                      </span>
                      <span>·</span>
                      <span>
                        {new Date(msg.timestamp).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </div>
                    <div className="text-[14px] text-[var(--text-primary)] leading-relaxed break-words font-sans">
                      <MarkdownRenderer content={msg.content} />
                    </div>
                  </div>
                ) : (
                  /* Agent Message: Aligned on the exact same left axis */
                  <div className="w-full space-y-2.5">
                    <div className="flex items-center gap-2 font-mono text-[11px] text-[var(--text-muted)] select-none">
                      <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-[var(--text-primary)] text-[var(--bg-canvas)] text-[10px]">
                        <Sparkles className="w-3 h-3 fill-current" />
                      </span>
                      <span className="font-semibold text-xs text-[var(--text-primary)] font-sans">
                        Agent
                      </span>
                      <span>·</span>
                      <span>
                        {new Date(msg.timestamp).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </div>

                    <div className="w-full space-y-3.5 text-[14px] text-[var(--text-primary)] font-sans">
                      {msg.parts && msg.parts.length > 0 ? (
                        <>
                          {msg.parts.map((part, pIdx) => {
                          if (part.type === "reasoning") {
                            if (!part.content && part.status !== "streaming") return null;
                            const isCollapsed = collapsedReasoning[part.id] ?? true;
                            const isStreaming = part.status === "streaming";

                            return (
                              <div
                                key={part.id || `reas_${pIdx}`}
                                className="border border-[var(--border-default)] rounded-[var(--radius-sm)] bg-[var(--bg-surface)] text-xs overflow-hidden"
                              >
                                <button
                                  type="button"
                                  onClick={() => toggleReasoning(part.id)}
                                  className="w-full px-3 py-1.5 bg-[var(--bg-table-header)] flex items-center justify-between hover:bg-[var(--bg-surface-hover)] transition-colors cursor-pointer select-none text-left font-mono"
                                >
                                  <div className="flex items-center gap-1.5">
                                    <ChevronRight
                                      className={`w-3 h-3 text-[var(--text-muted)] shrink-0 transition-transform duration-150 ${
                                        !isCollapsed ? "rotate-90" : ""
                                      }`}
                                    />
                                    <span className="font-semibold text-xs text-[var(--text-primary)]">Thinking Process</span>
                                    {isStreaming && (
                                      <span className="text-[10px] text-amber-500 font-mono animate-pulse">
                                        [Streaming...]
                                      </span>
                                    )}
                                  </div>
                                  <span className="text-[10px] text-[var(--text-muted)] font-mono">
                                    {isCollapsed ? "Click to expand" : "Fold"}
                                  </span>
                                </button>
                                <div className="collapsible-grid" data-open={!isCollapsed}>
                                  <div className="collapsible-inner">
                                    <div className="p-3 border-t border-[var(--border-default)] font-mono text-[11.5px] text-[var(--text-secondary)] whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto bg-[var(--bg-code)] select-text">
                                      {part.content || (isStreaming ? "Thinking..." : "")}
                                    </div>
                                  </div>
                                </div>
                              </div>
                            );
                          }

                          if (part.type === "command") {
                            const cmdId = part.id || `cmd_${pIdx}_${part.command}`;
                            const isCollapsed = collapsedCommands[cmdId] ?? true;

                            return (
                              <div
                                key={cmdId}
                                className="border border-[var(--border-default)] rounded-[var(--radius-sm)] bg-[var(--bg-surface)] overflow-hidden text-xs font-mono"
                              >
                                <button
                                  type="button"
                                  onClick={() => toggleCommand(cmdId)}
                                  className="w-full px-3 py-1.5 bg-[var(--bg-table-header)] flex items-center justify-between hover:bg-[var(--bg-surface-hover)] transition-colors cursor-pointer select-none text-left"
                                >
                                  <div className="flex items-center gap-2 min-w-0 pr-2">
                                    <ChevronRight
                                      className={`w-3 h-3 text-[var(--text-muted)] shrink-0 transition-transform duration-150 ${
                                        !isCollapsed ? "rotate-90" : ""
                                      }`}
                                    />
                                    <Terminal className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                                    <span className="font-semibold text-[var(--text-primary)] truncate font-mono text-xs" title={part.command}>
                                      {part.command}
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-2 shrink-0">
                                    <span
                                      className={`text-[10px] px-1.5 py-0.5 rounded-[var(--radius-xs)] font-mono ${
                                        part.status === "completed"
                                          ? "text-emerald-500 bg-emerald-500/10 border border-emerald-500/20"
                                          : part.status === "running"
                                            ? "text-amber-500 bg-amber-500/10 border border-amber-500/20 animate-pulse"
                                            : "text-red-500 bg-red-500/10 border border-red-500/20"
                                      }`}
                                    >
                                      {part.status}
                                    </span>
                                    <span className="text-[10px] text-[var(--text-muted)] font-mono">
                                      {isCollapsed ? "Expand" : "Fold"}
                                    </span>
                                  </div>
                                </button>
                                <div className="collapsible-grid" data-open={!isCollapsed}>
                                  <div className="collapsible-inner">
                                    <div className="p-3 border-t border-[var(--border-default)] text-[11.5px] text-[var(--text-code)] bg-[var(--bg-code)] whitespace-pre-wrap max-h-60 overflow-y-auto leading-relaxed font-mono select-text">
                                      {part.output || (part.status === "running" ? "Executing..." : "(No output)")}
                                    </div>
                                  </div>
                                </div>
                              </div>
                            );
                          }

                          if (part.type === "tool") {
                            const toolId = part.id || `tool_${pIdx}`;
                            const isCollapsed = collapsedTools[toolId] ?? true;
                            const hasOpened = toolId in collapsedTools;
                            const toolTitle = part.serverName
                              ? `${part.serverName}/${part.toolName}`
                              : part.toolName;
                            const formattedArgs =
                              hasOpened && part.args
                                ? JSON.stringify(part.args, null, 2)
                                : "";
                            const formattedResult =
                              hasOpened && part.result !== undefined
                                ? typeof part.result === "string"
                                  ? part.result
                                  : JSON.stringify(part.result, null, 2)
                                : "";

                            return (
                              <div
                                key={toolId}
                                className="border border-[var(--border-default)] rounded-[var(--radius-sm)] bg-[var(--bg-surface)] overflow-hidden text-xs font-mono"
                              >
                                <button
                                  type="button"
                                  onClick={() => toggleTool(toolId)}
                                  className="w-full px-3 py-1.5 bg-[var(--bg-table-header)] flex items-center justify-between hover:bg-[var(--bg-surface-hover)] transition-colors cursor-pointer select-none text-left"
                                >
                                  <div className="flex items-center gap-2 min-w-0 pr-2">
                                    <ChevronRight
                                      className={`w-3 h-3 text-[var(--text-muted)] shrink-0 transition-transform duration-150 ${
                                        !isCollapsed ? "rotate-90" : ""
                                      }`}
                                    />
                                    <Wrench className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
                                    <span
                                      className="font-semibold text-[var(--text-primary)] truncate font-mono text-xs"
                                      title={toolTitle}
                                    >
                                      {toolTitle}
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-2 shrink-0">
                                    <span
                                      className={`text-[10px] px-1.5 py-0.5 rounded-[var(--radius-xs)] font-mono ${
                                        part.status === "completed"
                                          ? "text-indigo-500 bg-indigo-500/10 border border-indigo-500/20"
                                          : part.status === "running"
                                            ? "text-amber-500 bg-amber-500/10 border border-amber-500/20 animate-pulse"
                                            : "text-red-500 bg-red-500/10 border border-red-500/20"
                                      }`}
                                    >
                                      {part.status}
                                    </span>
                                    <span className="text-[10px] text-[var(--text-muted)] font-mono">
                                      {isCollapsed ? "Expand" : "Fold"}
                                    </span>
                                  </div>
                                </button>
                                <div className="collapsible-grid" data-open={!isCollapsed}>
                                  <div className="collapsible-inner">
                                    {hasOpened && (
                                      <div className="p-3 border-t border-[var(--border-default)] text-[11.5px] text-[var(--text-code)] bg-[var(--bg-code)] max-h-72 overflow-y-auto leading-relaxed font-mono space-y-3">
                                        {formattedArgs && (
                                          <div>
                                            <div className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-1 select-none">
                                              Parameters
                                            </div>
                                            <pre className="p-2.5 rounded-[var(--radius-xs)] bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[11.5px] text-[var(--text-code)] font-mono overflow-x-auto whitespace-pre leading-relaxed select-text">
                                              {formattedArgs}
                                            </pre>
                                          </div>
                                        )}
                                        {formattedResult && (
                                          <div>
                                            <div className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-1 select-none">
                                              Result
                                            </div>
                                            <pre className="p-2.5 rounded-[var(--radius-xs)] bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[11.5px] text-[var(--text-code)] font-mono overflow-x-auto whitespace-pre leading-relaxed select-text">
                                              {formattedResult}
                                            </pre>
                                          </div>
                                        )}
                                        {!formattedArgs && !formattedResult && (
                                          <div className="text-xs text-[var(--text-muted)] italic select-none">
                                            {part.status === "running" ? "Invoking tool..." : "(No output)"}
                                          </div>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </div>
                            );
                          }

                          if (part.type === "text") {
                            if (!part.content) return null;
                            return (
                              <div key={part.id || `txt_${pIdx}`}>
                                <MarkdownRenderer content={part.content} />
                              </div>
                            );
                          }

                          return null;
                        })}
                        {!msg.parts.some((p) => p.type === "text") && msg.content && (
                          <MarkdownRenderer content={msg.content} />
                        )}
                      </>
                    ) : (
                      /* Fallback legacy rendering */
                        <>
                          {msg.thinking && (
                            <div className="border border-[var(--border-default)] rounded-[var(--radius-sm)] bg-[var(--bg-surface)] text-xs overflow-hidden">
                              <button
                                type="button"
                                onClick={() => toggleThinking(msg.id)}
                                className="w-full px-3 py-1.5 flex items-center justify-between text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)] transition-colors cursor-pointer font-mono"
                              >
                                <div className="flex items-center gap-1.5">
                                  <ChevronRight
                                    className={`w-3 h-3 transition-transform duration-150 ${
                                      !(collapsedThinking[msg.id] ?? true) ? "rotate-90" : ""
                                    }`}
                                  />
                                  <span>Thinking Process</span>
                                </div>
                              </button>
                              <div
                                className="collapsible-grid"
                                data-open={!(collapsedThinking[msg.id] ?? true)}
                              >
                                <div className="collapsible-inner">
                                  <div className="p-3 border-t border-[var(--border-default)] font-mono text-[11px] text-[var(--text-secondary)] whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto bg-[var(--bg-code)]">
                                    {msg.thinking}
                                  </div>
                                </div>
                              </div>
                            </div>
                          )}

                          {msg.commands && msg.commands.length > 0 && msg.commands.map((cmd, cIdx) => {
                            const cmdId = cmd.id || `legacy_cmd_${msg.id}_${cIdx}`;
                            const isCollapsed = collapsedCommands[cmdId] ?? true;

                            return (
                              <div
                                key={cmdId}
                                className="border border-[var(--border-default)] rounded-[var(--radius-sm)] bg-[var(--bg-surface)] overflow-hidden text-xs font-mono"
                              >
                                <button
                                  type="button"
                                  onClick={() => toggleCommand(cmdId)}
                                  className="w-full px-3 py-1.5 bg-[var(--bg-table-header)] flex items-center justify-between hover:bg-[var(--bg-surface-hover)] transition-colors cursor-pointer select-none text-left"
                                >
                                  <div className="flex items-center gap-2 min-w-0 pr-2">
                                    <ChevronRight
                                      className={`w-3 h-3 text-[var(--text-muted)] shrink-0 transition-transform duration-150 ${
                                        !isCollapsed ? "rotate-90" : ""
                                      }`}
                                    />
                                    <Terminal className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                                    <span className="font-semibold text-[var(--text-primary)] truncate font-mono text-xs" title={cmd.command}>
                                      {cmd.command}
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-2 shrink-0">
                                    <span
                                      className={`text-[10px] px-1.5 py-0.5 rounded-[var(--radius-xs)] font-mono ${
                                        cmd.status === "completed"
                                          ? "text-emerald-500 bg-emerald-500/10 border border-emerald-500/20"
                                          : cmd.status === "running"
                                            ? "text-amber-500 bg-amber-500/10 border border-amber-500/20 animate-pulse"
                                            : "text-red-500 bg-red-500/10 border border-red-500/20"
                                      }`}
                                    >
                                      {cmd.status}
                                    </span>
                                    <span className="text-[10px] text-[var(--text-muted)] font-mono">
                                      {isCollapsed ? "Expand" : "Fold"}
                                    </span>
                                  </div>
                                </button>
                                <div className="collapsible-grid" data-open={!isCollapsed}>
                                  <div className="collapsible-inner">
                                    <div className="p-3 border-t border-[var(--border-default)] text-[11.5px] text-[var(--text-code)] bg-[var(--bg-code)] whitespace-pre-wrap max-h-60 overflow-y-auto leading-relaxed font-mono select-text">
                                      {cmd.output || (cmd.status === "running" ? "Executing..." : "(No output)")}
                                    </div>
                                  </div>
                                </div>
                              </div>
                            );
                          })}

                          {msg.content && <MarkdownRenderer content={msg.content} />}
                        </>
                      )}

                      {/* Streaming indicator */}
                      {msg.status === "streaming" && (
                        <div className="flex items-center gap-2 text-xs text-[var(--text-muted)] pt-2 select-none">
                          <div className="flex gap-1 items-center">
                            <span className="w-1.5 h-1.5 rounded-full bg-[var(--text-secondary)] animate-bounce [animation-delay:-0.3s]" />
                            <span className="w-1.5 h-1.5 rounded-full bg-[var(--text-secondary)] animate-bounce [animation-delay:-0.15s]" />
                            <span className="w-1.5 h-1.5 rounded-full bg-[var(--text-secondary)] animate-bounce" />
                          </div>
                          <span className="text-[11px] font-mono thinking-shimmer">Agent is thinking...</span>
                        </div>
                      )}

                      {/* Interrupted indicator */}
                      {msg.status === "interrupted" && (
                        <div className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] pt-2 select-none font-mono">
                          <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                          <span className="text-[11px] text-[var(--text-muted)]">Generation interrupted</span>
                        </div>
                      )}

                      {/* Failed indicator */}
                      {msg.status === "failed" && (
                        <div className="flex items-start gap-2 px-3 py-2 rounded-[var(--radius-sm)] border border-red-500/30 bg-red-500/10 text-xs text-red-400 font-mono">
                          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-red-500" />
                          <span className="break-words leading-relaxed">
                            {msg.error || "Turn failed"}
                          </span>
                        </div>
                      )}

                      {/* Per-turn normalized model usage metadata */}
                      {msg.usage && msg.usage.totalTokens > 0 && (() => {
                        const u = msg.usage;
                        const hitRate = calculateCacheHitRate(u);
                        const isUsageOpen = !!expandedUsage[msg.id];
                        const hasDetails =
                          u.cacheWriteTokens > 0 ||
                          u.reasoningTokens > 0 ||
                          (u.byModel && u.byModel.length > 1) ||
                          (u.contextUsedTokens !== undefined && u.contextWindowTokens !== undefined);
                        const tooltip = [
                          u.model ? `Model: ${u.model}` : null,
                          `Input (uncached): ${u.inputTokens.toLocaleString()}`,
                          `Cache Read: ${u.cacheReadTokens.toLocaleString()}${hitRate !== null ? ` (${hitRate}%)` : ""}`,
                          u.cacheWriteTokens > 0
                            ? `Cache Write: ${u.cacheWriteTokens.toLocaleString()}`
                            : null,
                          `Output: ${u.outputTokens.toLocaleString()}`,
                          u.reasoningTokens > 0
                            ? `Reasoning: ${u.reasoningTokens.toLocaleString()}`
                            : null,
                          `Total: ${u.totalTokens.toLocaleString()}`,
                        ]
                          .filter(Boolean)
                          .join(" | ");

                        return (
                          <div className="pt-1 select-none">
                            <button
                              type="button"
                              onClick={() => toggleUsage(msg.id)}
                              title={tooltip}
                              className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5 px-2 py-0.5 rounded-[var(--radius-xs)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] hover:border-[var(--border-default)] text-[10.5px] font-mono text-[var(--text-muted)] transition-colors cursor-pointer"
                            >
                              {u.model && (
                                <span className="text-[var(--text-secondary)] font-medium">
                                  {u.model}
                                </span>
                              )}
                              <span>In {formatTokenCount(u.inputTokens)}</span>
                              {u.cacheReadTokens > 0 && (
                                <span className="text-emerald-500">
                                  Cache {formatTokenCount(u.cacheReadTokens)}
                                  {hitRate !== null ? ` (${hitRate}%)` : ""}
                                </span>
                              )}
                              {u.cacheWriteTokens > 0 && (
                                <span>Write {formatTokenCount(u.cacheWriteTokens)}</span>
                              )}
                              <span>Out {formatTokenCount(u.outputTokens)}</span>
                              {u.reasoningTokens > 0 && (
                                <span>Think {formatTokenCount(u.reasoningTokens)}</span>
                              )}
                              {hasDetails && (
                                <ChevronRight
                                  className={`w-2.5 h-2.5 opacity-70 transition-transform duration-150 ${
                                    isUsageOpen ? "rotate-90" : ""
                                  }`}
                                />
                              )}
                            </button>

                            <div className="collapsible-grid" data-open={isUsageOpen}>
                              <div className="collapsible-inner">
                                <div className="mt-1.5 p-2.5 rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-surface)] text-[11px] font-mono text-[var(--text-secondary)] space-y-1.5 select-text">
                                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10.5px]">
                                    <span>Total: <strong className="text-[var(--text-primary)]">{u.totalTokens.toLocaleString()}</strong></span>
                                    <span>Uncached In: {u.inputTokens.toLocaleString()}</span>
                                    <span>Cache Read: {u.cacheReadTokens.toLocaleString()}{hitRate !== null ? ` (${hitRate}%)` : ""}</span>
                                    <span>Cache Write: {u.cacheWriteTokens.toLocaleString()}</span>
                                    <span>Output: {u.outputTokens.toLocaleString()}</span>
                                    {u.reasoningTokens > 0 && (
                                      <span>Reasoning: {u.reasoningTokens.toLocaleString()}</span>
                                    )}
                                    {u.contextUsedTokens !== undefined && u.contextWindowTokens !== undefined && (
                                      <span>
                                        Context: {formatTokenCount(u.contextUsedTokens)} / {formatTokenCount(u.contextWindowTokens)} (
                                        {Math.min(100, Math.round((u.contextUsedTokens / u.contextWindowTokens) * 100))}%)
                                      </span>
                                    )}
                                  </div>
                                  {u.byModel && u.byModel.length > 1 && (
                                    <div className="pt-1.5 border-t border-[var(--border-subtle)] space-y-1">
                                      <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                                        By Model
                                      </div>
                                      {u.byModel.map((entry) => (
                                        <div
                                          key={`${entry.provider ?? ""}:${entry.model}`}
                                          className="flex flex-wrap items-center justify-between gap-2 text-[10.5px]"
                                        >
                                          <span className="text-[var(--text-primary)]">
                                            {entry.model}
                                          </span>
                                          <span className="text-[var(--text-muted)]">
                                            In {formatTokenCount(entry.inputTokens)} · Cache {formatTokenCount(entry.cacheReadTokens)} · Out {formatTokenCount(entry.outputTokens)}
                                          </span>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Floating Scroll-to-Bottom Pill Button (When user scrolled up during or after streaming) */}
      <div
        className={`absolute ${isClosed ? "bottom-20" : "bottom-44"} left-1/2 -translate-x-1/2 z-30 pointer-events-none`}
      >
        <AnimatePresence>
          {showScrollBottomBtn && (
            <m.button
              key="scroll-to-bottom"
              type="button"
              onClick={scrollToBottom}
              initial={{ opacity: 0, y: 10, scale: 0.94 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.94 }}
              transition={SPRING_SNAPPY}
              className="pointer-events-auto flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[var(--bg-surface-elevated)] border border-[var(--border-strong)] shadow-lg hover:bg-[var(--bg-surface-hover)] active:scale-95 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer select-none"
              title="Scroll to bottom"
            >
              <ChevronDown className="w-3.5 h-3.5" />
              <span className="font-mono text-[11px]">Scroll to bottom</span>
              {isRunning && (
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse ml-0.5" />
              )}
            </m.button>
          )}
        </AnimatePresence>
      </div>

      {/* Floating Input Composer or Closed Session Banner */}
      <div className="absolute bottom-0 inset-x-0 z-20 pointer-events-none pb-4 pt-10 bg-gradient-to-t from-[var(--bg-canvas)] via-[var(--bg-canvas)]/90 via-50% to-transparent">
        {isClosed ? (
          <div
            className={
              embedded
                ? "px-5 w-full pointer-events-auto select-none"
                : "max-w-3xl mx-auto px-4 w-full pointer-events-auto select-none"
            }
          >
            <div className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-surface)]/95 backdrop-blur-md text-xs text-[var(--text-muted)] font-mono">
              <Archive className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
              <span>{closedReason || "This session is closed and read-only."}</span>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="max-w-3xl mx-auto px-4 w-full pointer-events-auto">
            {/* Capsule Card Container */}
            <div className="relative flex flex-col rounded-2xl border border-[var(--border-strong)] bg-[var(--bg-card)] focus-within:border-[var(--border-focus)] transition-all duration-200">
              {/* Auto-growing Textarea */}
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                onCompositionStart={handleCompositionStart}
                onCompositionEnd={handleCompositionEnd}
                placeholder="Message Agent..."
                className="w-full pt-3.5 px-4 pb-1.5 bg-transparent outline-none resize-none text-[14px] text-[var(--text-primary)] placeholder-[var(--text-muted)] min-h-[44px] max-h-[200px] font-sans leading-relaxed overflow-y-auto"
                rows={1}
              />

              {/* Bottom Toolbar inside the pill */}
              <div className="flex items-center justify-end px-3 pb-2.5 pt-1">
                {/* Right Circular Send / Stop Action Button */}
                <div className="flex items-center gap-2">
                  {isRunning ? (
                    <button
                      type="button"
                      onClick={onInterrupt}
                      className="w-8 h-8 rounded-full flex items-center justify-center bg-[var(--text-primary)] text-[var(--bg-canvas)] hover:opacity-85 active:scale-95 transition-all cursor-pointer shadow-sm select-none"
                      title="Stop generation"
                    >
                      <Square className="w-3.5 h-3.5 fill-current" />
                    </button>
                  ) : isSubmitting ? (
                    <button
                      type="button"
                      disabled
                      className="w-8 h-8 rounded-full flex items-center justify-center bg-[var(--text-primary)] text-[var(--bg-canvas)] opacity-80 cursor-wait shadow-sm select-none"
                      title="Sending..."
                    >
                      <Loader2 className="w-4 h-4 animate-spin stroke-[2.5]" />
                    </button>
                  ) : (
                    <button
                      type="submit"
                      disabled={!input.trim()}
                      className={`w-8 h-8 rounded-full flex items-center justify-center transition-all select-none ${
                        input.trim()
                          ? "bg-[var(--text-primary)] text-[var(--bg-canvas)] hover:opacity-90 active:scale-95 shadow-sm cursor-pointer"
                          : "bg-[var(--bg-surface-hover)] text-[var(--text-muted)] opacity-35 cursor-not-allowed"
                      }`}
                      title="Send message"
                    >
                      <ArrowUp className="w-4 h-4 stroke-[2.5]" />
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Micro-copy disclaimer below container */}
            <div className="text-center mt-2 select-none">
              <span className="text-[11px] text-[var(--text-muted)] font-sans">
                Agent can make mistakes. Verify critical actions in code.
              </span>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
