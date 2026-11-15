import type { EventHub } from "../../events/hub.ts";
import type { EventRecord } from "../../domain/types.ts";
import type { Logger } from "../../observability/logger.ts";
import { WeComClient } from "./client.ts";
import { buildWeComMarkdown } from "./card.ts";
import { GLOBAL_PROJECT_ID } from "../../project/global.ts";

export interface WeComStreamerConfig {
  throttleMs?: number;
}

export interface WeComTurnContext {
  chatId: string;
  reqId?: string | undefined;
  streamId?: string | undefined;
  projectId?: string | undefined;
}

interface WeComTurnStream {
  sessionId: string;
  turnId: string;
  chatId: string;
  reqId?: string;
  streamId: string;
  projectId?: string;
  phases: Map<string, string>;
  text: string;
  final: string;
  status: string;
  finished: boolean;
  outcome: "" | "completed" | "failed" | "interrupted";
  startedAt: number;
  artifacts: Array<{ kind: string; name?: string; id?: string }>;
  dirty: boolean;
  timer?: Timer;
  inFlight?: Promise<void>;
  pendingFlush: boolean;
}

interface WeComSessionSubscription {
  sessionId: string;
  chatId: string;
  projectId?: string;
  source: string;
  controller: AbortController;
  pendingTurns: WeComTurnContext[];
  turns: Map<string, WeComTurnStream>;
  task: Promise<void>;
}

export class WeComSessionStreamer {
  private readonly throttleMs: number;
  private readonly sessions = new Map<string, WeComSessionSubscription>();

  constructor(
    private readonly eventHub: EventHub,
    private readonly client: WeComClient,
    private readonly logger?: Logger,
    config: WeComStreamerConfig = {},
  ) {
    this.throttleMs = config.throttleMs ?? 250;
  }

  /** Starts one EventHub subscription for the whole Session. */
  ensureSession(params: {
    sessionId: string;
    chatId: string;
    projectId?: string;
    source?: string;
    after?: number;
  }): void {
    if (!this.client.isConfigured() || this.sessions.has(params.sessionId)) return;

    const subscription: WeComSessionSubscription = {
      sessionId: params.sessionId,
      chatId: params.chatId,
      ...(params.projectId ? { projectId: params.projectId } : {}),
      source: params.source ?? "wecom",
      controller: new AbortController(),
      pendingTurns: [],
      turns: new Map(),
      task: Promise.resolve(),
    };
    this.sessions.set(params.sessionId, subscription);
    subscription.task = this.runSession(subscription, params.after).catch((error) => {
      this.logger?.error("WeCom Session subscription failed", {
        sessionId: params.sessionId,
        error: (error as Error).message,
      });
    });
  }

  /** Registers the next inbound message before its Turn is admitted. */
  enqueueTurn(sessionId: string, context: WeComTurnContext): WeComTurnContext | undefined {
    const subscription = this.sessions.get(sessionId);
    if (!subscription) return undefined;
    subscription.pendingTurns.push(context);
    return context;
  }

  discardTurn(sessionId: string, context?: WeComTurnContext): void {
    const pending = this.sessions.get(sessionId)?.pendingTurns;
    if (!pending || !context) return;
    const index = pending.lastIndexOf(context);
    if (index >= 0) pending.splice(index, 1);
  }

  async closeSession(sessionId: string): Promise<void> {
    const subscription = this.sessions.get(sessionId);
    if (!subscription) return;
    subscription.controller.abort();
    await subscription.task;
    if (this.sessions.get(sessionId) === subscription) this.sessions.delete(sessionId);
  }

  async stop(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((sessionId) => this.closeSession(sessionId)));
  }

  private async runSession(subscription: WeComSessionSubscription, after?: number): Promise<void> {
    try {
      for await (const event of this.eventHub.stream(subscription.sessionId, {
        source: subscription.source,
        ...(after !== undefined ? { after } : {}),
        signal: subscription.controller.signal,
      })) {
        if (event.type === "session.closed" || event.type === "session.archived") break;
        const turnId = event.turnId ?? (event.payload as any)?.turnId;
        if (!turnId) continue;

        let turnStream = subscription.turns.get(turnId);
        if (!turnStream) {
          const context = subscription.pendingTurns.shift();
          if (!context) continue;
          turnStream = this.newTurnStream(subscription, turnId, context);
          subscription.turns.set(turnId, turnStream);
          await this.sendInitialStream(turnStream);
        }

        this.applyTurnEvent(turnStream, event);
        turnStream.dirty = true;
        if (turnStream.finished) {
          await this.flushTurnStream(turnStream, true);
        } else {
          this.scheduleTurnFlush(turnStream);
        }
      }
    } finally {
      for (const stream of subscription.turns.values()) {
        if (stream.timer) clearTimeout(stream.timer);
        await this.flushTurnStream(stream, true);
      }
      if (this.sessions.get(subscription.sessionId) === subscription) {
        this.sessions.delete(subscription.sessionId);
      }
    }
  }

  private newTurnStream(
    subscription: WeComSessionSubscription,
    turnId: string,
    context: WeComTurnContext,
  ): WeComTurnStream {
    return {
      sessionId: subscription.sessionId,
      turnId,
      chatId: context.chatId,
      ...(context.reqId ? { reqId: context.reqId } : {}),
      streamId: context.streamId ?? `stream_${turnId}`,
      ...(context.projectId ? { projectId: context.projectId } : {}),
      phases: new Map(),
      text: "",
      final: "",
      status: "⏳ 正在分析需求并规划任务...",
      finished: false,
      outcome: "",
      startedAt: Date.now(),
      artifacts: [],
      dirty: false,
      pendingFlush: false,
    };
  }

  private async sendInitialStream(stream: WeComTurnStream): Promise<void> {
    if (!stream.reqId) return;
    try {
      const initialMarkdown = buildWeComMarkdown({
        statusLine:
          stream.projectId === GLOBAL_PROJECT_ID
            ? "💡 未锁定特定项目，已进入全局只读工作区，可跨工程检索与分析"
            : stream.status,
        isFinished: false,
      });
      await this.client.replyStream(stream.reqId, stream.streamId, initialMarkdown, false);
    } catch (error) {
      this.logger?.warn("WeCom Turn initial stream failed", {
        sessionId: stream.sessionId,
        turnId: stream.turnId,
        error: (error as Error).message,
      });
    }
  }

  private applyTurnEvent(stream: WeComTurnStream, event: EventRecord): void {
    this.handleEvent(event, stream.phases, {
      onThought: () => {
        stream.status = "💭 正在思考中...";
      },
      onTool: (desc) => {
        stream.status = `⚡ 正在执行: ${desc}`;
      },
      onDelta: (text) => {
        stream.text += text;
      },
      onCompletedText: (text, phase) => {
        if (phase === "commentary" || phase === "partial_answer") {
          stream.status = text.slice(0, 800);
          stream.text = "";
        } else {
          stream.final = text;
          stream.text = "";
        }
      },
      onArtifact: (artifact) => stream.artifacts.push(artifact),
      onFinished: (status, finalTurnText) => {
        stream.finished = true;
        stream.outcome = status;
        if (finalTurnText?.trim()) stream.final = finalTurnText.trim();
        stream.status =
          status === "completed"
            ? "💡 任务已完成"
            : status === "failed"
              ? "❌ 任务执行出错"
              : "⚠️ 任务已中断";
      },
    });
  }

  private scheduleTurnFlush(stream: WeComTurnStream): void {
    if (stream.timer) return;
    stream.timer = setTimeout(() => {
      delete stream.timer;
      void this.flushTurnStream(stream);
    }, this.throttleMs);
  }

  private async flushTurnStream(stream: WeComTurnStream, force = false): Promise<void> {
    if (!stream.dirty && !force) return;
    stream.dirty = false;

    if (stream.inFlight) {
      stream.pendingFlush = true;
      await stream.inFlight;
      if (stream.pendingFlush || force) {
        stream.pendingFlush = false;
        await this.flushTurnStream(stream, true);
      }
      return;
    }

    const durationMs = Date.now() - stream.startedAt;
    const finalContent = stream.final.trim() || stream.text.trim();
    const markdown = buildWeComMarkdown({
      statusLine: stream.status,
      ...(stream.finished ? { contentMarkdown: finalContent } : {}),
      artifacts: stream.artifacts,
      durationMs,
      isFinished: stream.finished,
      outcome: stream.outcome,
    });

    const sendAction = async () => {
      try {
        if (stream.reqId) {
          await this.client.replyStream(
            stream.reqId,
            stream.streamId,
            markdown,
            stream.finished,
          );
        } else if (stream.finished) {
          // If no reqId (e.g. background proactive turn), deliver via sendMessage
          await this.client.sendMessage(stream.chatId, {
            msgtype: "markdown",
            markdown: { content: markdown },
          });
        }
      } catch (err: any) {
        this.logger?.warn("WeCom Turn stream update failed", {
          sessionId: stream.sessionId,
          turnId: stream.turnId,
          error: err?.message,
        });
      }
    };

    stream.inFlight = sendAction();
    try {
      await stream.inFlight;
    } finally {
      delete stream.inFlight;
    }

    if (stream.pendingFlush) {
      stream.pendingFlush = false;
      await this.flushTurnStream(stream, true);
    }
  }

  private handleEvent(
    event: EventRecord,
    itemPhases: Map<string, string>,
    handlers: {
      onThought: () => void;
      onTool: (desc: string) => void;
      onDelta: (text: string, phase?: string) => void;
      onCompletedText: (text: string, phase?: string) => void;
      onArtifact: (art: { kind: string; name?: string; id?: string }) => void;
      onFinished: (status: "completed" | "failed" | "interrupted", finalTurnText?: string) => void;
    },
  ): void {
    const payload = (event.payload as Record<string, any>) ?? {};

    // 1. Thought / Reasoning filtering
    if (
      event.type === "agent.reasoning" ||
      event.type === "agent.reasoning.delta" ||
      event.type === "agent.reasoning.completed"
    ) {
      handlers.onThought();
      return;
    }

    // 2. Assistant message delta
    if (event.type === "agent.message.delta") {
      const text = String(payload.delta ?? payload.text ?? "");
      const phase = typeof payload.phase === "string" ? payload.phase : undefined;
      if (text) {
        handlers.onDelta(text, phase);
      }
      return;
    }

    // 3. Assistant message completed
    if (event.type === "agent.message.completed") {
      const text = String(payload.text ?? "");
      const phase = typeof payload.phase === "string" ? payload.phase : undefined;
      handlers.onCompletedText(text, phase);
      return;
    }

    // 4. Artifact created
    if (event.type === "artifact.created") {
      const kind = String(payload.kind ?? "file");
      if (kind === "agent-message") return;
      handlers.onArtifact({
        kind,
        ...(typeof payload.path === "string" ? { name: payload.path } : {}),
        ...(typeof payload.artifactId === "string" ? { id: payload.artifactId } : {}),
      });
      return;
    }

    // 5. Tool calls / Command execution / File changes
    if (
      event.type === "command.started" ||
      event.type === "file_change.started" ||
      event.type === "mcp_call.started" ||
      event.type === "tool.call.started"
    ) {
      const desc =
        typeof payload.command === "string"
          ? `命令: ${payload.command.slice(0, 50)}`
          : typeof payload.path === "string"
            ? `文件: ${payload.path}`
            : typeof payload.toolName === "string"
              ? `工具: ${payload.toolName}`
              : "工具调用";
      handlers.onTool(desc);
      return;
    }

    // 6. Turn lifecycle
    if (event.type === "turn.completed") {
      const finalText = typeof payload.finalText === "string" ? payload.finalText : undefined;
      handlers.onFinished("completed", finalText);
      return;
    }
    if (event.type === "turn.failed") {
      handlers.onFinished("failed");
      return;
    }
    if (event.type === "turn.interrupted") {
      handlers.onFinished("interrupted");
      return;
    }
  }
}
