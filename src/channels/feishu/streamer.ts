import type { EventHub } from "../../events/hub.ts";
import type { EventRecord } from "../../domain/types.ts";
import type { Logger } from "../../observability/logger.ts";
import { FeishuClient } from "./client.ts";
import { buildFeishuCard, type CardHeaderTemplate } from "./card.ts";
import { GLOBAL_PROJECT_ID } from "../../project/global.ts";

export interface FeishuStreamerConfig {
  throttleMs?: number;
}

interface FeishuTurnContext {
  chatId: string;
  rootId?: string;
  projectId?: string;
}

interface FeishuTurnCard {
  sessionId: string;
  turnId: string;
  chatId: string;
  rootId?: string;
  projectId?: string;
  showTitle: boolean;
  messageId?: string;
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

interface FeishuSessionSubscription {
  sessionId: string;
  chatId: string;
  projectId?: string;
  source: string;
  controller: AbortController;
  pendingTurns: FeishuTurnContext[];
  cards: Map<string, FeishuTurnCard>;
  task: Promise<void>;
}

export class FeishuSessionStreamer {
  private readonly throttleMs: number;
  private readonly sessions = new Map<string, FeishuSessionSubscription>();

  constructor(
    private readonly eventHub: EventHub,
    private readonly client: FeishuClient,
    private readonly logger?: Logger,
    config: FeishuStreamerConfig = {},
  ) {
    this.throttleMs = config.throttleMs ?? 600;
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
    const subscription: FeishuSessionSubscription = {
      sessionId: params.sessionId,
      chatId: params.chatId,
      ...(params.projectId ? { projectId: params.projectId } : {}),
      source: params.source ?? "feishu",
      controller: new AbortController(),
      pendingTurns: [],
      cards: new Map(),
      task: Promise.resolve(),
    };
    this.sessions.set(params.sessionId, subscription);
    subscription.task = this.runSession(subscription, params.after).catch((error) => {
      this.logger?.error("Feishu Session subscription failed", {
        sessionId: params.sessionId,
        error: (error as Error).message,
      });
    });
  }

  /** Registers the next inbound message before its Turn is admitted. */
  enqueueTurn(sessionId: string, context: FeishuTurnContext): FeishuTurnContext | undefined {
    const subscription = this.sessions.get(sessionId);
    if (!subscription) return undefined;
    subscription.pendingTurns.push(context);
    return context;
  }

  discardTurn(sessionId: string, context?: FeishuTurnContext): void {
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

  private async runSession(subscription: FeishuSessionSubscription, after?: number): Promise<void> {
    try {
      for await (const event of this.eventHub.stream(subscription.sessionId, {
        source: subscription.source,
        ...(after !== undefined ? { after } : {}),
        signal: subscription.controller.signal,
      })) {
        if (event.type === "session.closed" || event.type === "session.archived") break;
        const turnId = event.turnId ?? (event.payload as any)?.turnId;
        if (!turnId) continue;
        let card = subscription.cards.get(turnId);
        if (!card) {
          const context = subscription.pendingTurns.shift();
          if (!context) continue;
          card = this.newTurnCard(subscription, turnId, context);
          subscription.cards.set(turnId, card);
          await this.sendInitialCard(card);
        }
        this.applyTurnEvent(card, event);
        card.dirty = true;
        if (card.finished) await this.flushTurnCard(card, true);
        else this.scheduleTurnFlush(card);
      }
    } finally {
      for (const card of subscription.cards.values()) {
        if (card.timer) clearTimeout(card.timer);
        await this.flushTurnCard(card, true);
      }
      if (this.sessions.get(subscription.sessionId) === subscription)
        this.sessions.delete(subscription.sessionId);
    }
  }

  private newTurnCard(
    subscription: FeishuSessionSubscription,
    turnId: string,
    context: FeishuTurnContext,
  ): FeishuTurnCard {
    return {
      sessionId: subscription.sessionId,
      turnId,
      chatId: context.chatId,
      ...(context.rootId ? { rootId: context.rootId } : {}),
      ...(context.projectId ? { projectId: context.projectId } : {}),
      showTitle: subscription.cards.size === 0 && context.projectId === GLOBAL_PROJECT_ID,
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

  private async sendInitialCard(card: FeishuTurnCard): Promise<void> {
    try {
      card.messageId = await this.client.sendCard({
        receiveId: card.chatId,
        receiveIdType: "chat_id",
        ...(card.rootId ? { rootId: card.rootId } : {}),
        card: buildFeishuCard({
          ...(card.showTitle ? { title: "🌐 全局分析模式 (只读)" } : {}),
          headerTemplate: "blue",
          showHeader: card.showTitle,
          statusLine:
            card.projectId === GLOBAL_PROJECT_ID
              ? "💡 未锁定特定项目，已进入全局只读工作区，可跨工程检索与分析"
              : card.status,
        }),
      });
    } catch (error) {
      this.logger?.warn("Feishu Turn initial card failed", {
        sessionId: card.sessionId,
        turnId: card.turnId,
        error: (error as Error).message,
      });
    }
  }

  private applyTurnEvent(card: FeishuTurnCard, event: EventRecord): void {
    this.handleEvent(event, card.phases, {
      onThought: () => {
        card.status = "💭 正在思考中...";
      },
      onTool: (desc) => {
        card.status = `⚡ 正在执行: ${desc}`;
      },
      onDelta: (text) => {
        card.text += text;
      },
      onCompletedText: (text, phase) => {
        if (phase === "commentary" || phase === "partial_answer") {
          card.status = text.slice(0, 800);
          card.text = "";
        } else {
          card.final = text;
          card.text = "";
        }
      },
      onArtifact: (artifact) => card.artifacts.push(artifact),
      onFinished: (status, finalTurnText) => {
        card.finished = true;
        card.outcome = status;
        if (finalTurnText?.trim()) card.final = finalTurnText.trim();
        card.status =
          status === "completed"
            ? "💡 任务已完成"
            : status === "failed"
              ? "❌ 任务执行出错"
              : "⚠️ 任务已中断";
      },
    });
  }

  private scheduleTurnFlush(card: FeishuTurnCard): void {
    if (card.timer || !card.messageId) return;
    card.timer = setTimeout(() => {
      delete card.timer;
      void this.flushTurnCard(card);
    }, this.throttleMs);
  }

  private async flushTurnCard(card: FeishuTurnCard, force = false): Promise<void> {
    if (!card.messageId || (!card.dirty && !force)) return;
    card.dirty = false;
    if (card.inFlight) {
      card.pendingFlush = true;
      await card.inFlight;
      if (!card.pendingFlush && !force) return;
      card.pendingFlush = false;
    }
    const global = card.projectId === GLOBAL_PROJECT_ID;
    const title = card.finished
      ? card.outcome === "completed"
        ? global
          ? "✅ 全局分析完成 (只读)"
          : "✅ Agent 执行完成"
        : card.outcome === "failed"
          ? "❌ Agent 执行失败"
          : "⚠️ Agent 执行已中断"
      : global
        ? "🌐 全局分析模式 (只读)"
        : "🔄 Agent 正在处理中";
    const cardPayload = buildFeishuCard({
      ...(card.showTitle ? { title } : {}),
      headerTemplate: card.finished
        ? card.outcome === "completed"
          ? "green"
          : card.outcome === "failed"
            ? "red"
            : "orange"
        : "blue",
      showHeader: card.showTitle,
      statusLine: card.status,
      ...(card.finished ? { contentMarkdown: card.final || card.text } : {}),
      artifacts: card.artifacts,
      durationMs: Date.now() - card.startedAt,
      isFinished: card.finished,
    });
    card.inFlight = this.client
      .updateCard({ messageId: card.messageId, card: cardPayload })
      .catch((error) => {
        this.logger?.warn("Feishu Turn card update failed", {
          sessionId: card.sessionId,
          turnId: card.turnId,
          error: (error as Error).message,
        });
      });
    try {
      await card.inFlight;
    } finally {
      delete card.inFlight;
    }
    if (card.pendingFlush) {
      card.pendingFlush = false;
      await this.flushTurnCard(card, true);
    }
  }

  async streamSession(params: {
    sessionId: string;
    chatId: string;
    rootId?: string;
    projectId?: string;
    source?: string;
    after?: number;
  }): Promise<void> {
    if (!this.client.isConfigured()) {
      this.logger?.debug("FeishuClient not configured, skipping outbound card streamer", {
        sessionId: params.sessionId,
      });
      return;
    }

    const startedAt = Date.now();
    let messageId: string | null = null;
    const isGlobal = params.projectId === GLOBAL_PROJECT_ID;

    try {
      // 1. Send initial card
      const initialCard = buildFeishuCard({
        title: isGlobal ? "🌐 全局分析模式 (只读)" : "🔄 Agent 正在处理中",
        headerTemplate: "blue",
        statusLine: isGlobal
          ? "💡 未锁定特定项目，已进入全局只读工作区，可跨工程检索与分析"
          : "⏳ 正在分析需求并规划任务...",
      });

      messageId = await this.client.sendCard({
        receiveId: params.chatId,
        receiveIdType: "chat_id",
        ...(params.rootId ? { rootId: params.rootId } : {}),
        card: initialCard,
      });

      this.logger?.info("Feishu initial card sent", {
        sessionId: params.sessionId,
        messageId,
        chatId: params.chatId,
      });
    } catch (err) {
      this.logger?.error("Feishu send initial card failed", {
        sessionId: params.sessionId,
        chatId: params.chatId,
        error: (err as Error).message,
      });
      return;
    }

    // 2. Stream state tracking
    let isFinished = false;
    let headerTemplate: CardHeaderTemplate = "blue";
    let title = isGlobal ? "🌐 全局分析模式 (只读)" : "🔄 Agent 正在处理中";
    let statusLine = isGlobal
      ? "💡 未锁定特定项目，已进入全局只读工作区，可跨工程检索与分析"
      : "⏳ 正在分析需求并规划任务...";
    let finalAnswer = "";
    let lastCompletedText = "";
    let accumulatedText = "";
    const artifacts: Array<{ kind: string; name?: string; id?: string }> = [];
    let isDirty = false;
    let inFlight: Promise<void> | null = null;
    let pendingFlush = false;

    const itemPhases = new Map<string, string>();

    const doUpdate = async () => {
      if (!messageId) return;
      const durationMs = Date.now() - startedAt;
      const finalContent = finalAnswer.trim() || lastCompletedText.trim() || accumulatedText.trim();
      const card = buildFeishuCard({
        title,
        headerTemplate,
        statusLine,
        // Only render main text on completion; intermediate updates are shown via quote status blocks
        ...(isFinished ? { contentMarkdown: finalContent } : {}),
        artifacts,
        durationMs,
        isFinished,
      });

      try {
        await this.client.updateCard({ messageId, card });
      } catch (err) {
        this.logger?.warn("Feishu updateCard failed in streamer", {
          sessionId: params.sessionId,
          messageId,
          error: (err as Error).message,
        });
      }
    };

    const flush = async (force = false) => {
      if (!messageId || (!isDirty && !force)) return;
      isDirty = false;

      // If a card update network request is in-flight, await completion and ensure latest state is flushed
      if (inFlight) {
        pendingFlush = true;
        await inFlight;
        if (pendingFlush || force) {
          pendingFlush = false;
          inFlight = doUpdate();
          await inFlight;
          inFlight = null;
        }
        return;
      }

      inFlight = doUpdate();
      try {
        await inFlight;
      } finally {
        inFlight = null;
      }

      if (pendingFlush) {
        pendingFlush = false;
        inFlight = doUpdate();
        try {
          await inFlight;
        } finally {
          inFlight = null;
        }
      }
    };

    // Periodic flush timer for throttled streaming
    const timer = setInterval(() => {
      if (isDirty && !isFinished && !inFlight) {
        void flush();
      }
    }, this.throttleMs);

    const ac = new AbortController();

    try {
      const source = params.source ?? "feishu";
      for await (const event of this.eventHub.stream(params.sessionId, {
        source,
        ...(params.after !== undefined ? { after: params.after } : {}),
        signal: ac.signal,
      })) {
        this.handleEvent(event, itemPhases, {
          onThought: () => {
            statusLine = "💭 正在思考中...";
            isDirty = true;
          },
          onTool: (desc) => {
            statusLine = `⚡ 正在执行: ${desc}`;
            isDirty = true;
          },
          onDelta: (deltaText, _phase) => {
            accumulatedText += deltaText;
          },
          onCompletedText: (fullText, phase) => {
            const text = fullText?.trim() || accumulatedText.trim();
            if (!text) return;

            if (phase === "commentary" || phase === "partial_answer") {
              // Non-final answer: replace status quote block directly without streaming text
              statusLine = text.length > 800 ? `${text.slice(0, 800)}...` : text;
              accumulatedText = "";
              isDirty = true;
            } else if (phase === "final_answer") {
              // Final answer: save to finalAnswer and mount to body when turn completes
              finalAnswer = text;
              accumulatedText = "";
            } else {
              // Generic message without explicit phase: update status quote and keep as fallback
              lastCompletedText = text;
              statusLine = text.length > 800 ? `${text.slice(0, 800)}...` : text;
              accumulatedText = "";
              isDirty = true;
            }
          },
          onArtifact: (art) => {
            artifacts.push(art);
            isDirty = true;
          },
          onFinished: (status, finalTurnText) => {
            isFinished = true;
            if (finalTurnText?.trim()) {
              finalAnswer = finalTurnText.trim();
            }
            if (status === "completed") {
              headerTemplate = "green";
              title = isGlobal ? "✅ 全局分析完成 (只读)" : "✅ Agent 执行完成";
              statusLine = isGlobal ? "💡 全局分析完成" : "💡 任务已完成";
            } else if (status === "failed") {
              headerTemplate = "red";
              title = isGlobal ? "❌ 全局分析失败" : "❌ Agent 执行失败";
              statusLine = "❌ 任务执行出错";
            } else {
              headerTemplate = "orange";
              title = isGlobal ? "⚠️ 全局分析已中断" : "⚠️ Agent 执行已中断";
              statusLine = "⚠️ 任务已中断";
            }
            isDirty = true;
          },
        });

        if (isFinished) {
          break;
        }
      }
    } finally {
      clearInterval(timer);
      ac.abort();
      // Final flush
      await flush(true);
      this.logger?.info("Feishu session streaming completed", {
        sessionId: params.sessionId,
        messageId,
        isFinished,
        durationMs: Date.now() - startedAt,
      });
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
