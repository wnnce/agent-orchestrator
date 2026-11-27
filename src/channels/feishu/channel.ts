import type { SessionRoute } from "../../domain/types.ts";
import type { EventHub } from "../../events/hub.ts";
import type { Logger } from "../../observability/logger.ts";
import type { SessionManager } from "../../session/index.ts";
import type { Channel, InboundCommand, InboundEnvelope, InboundSink } from "../types.ts";
import { buildFeishuCard } from "./card.ts";
import { FeishuClient, type FeishuClientConfig } from "./client.ts";
import { FeishuSessionStreamer } from "./streamer.ts";
import { FeishuWSAdapter } from "./ws.ts";

export interface FeishuChannelDeps {
  readonly eventHub: EventHub;
  readonly sessionManager: SessionManager;
  readonly logger: Logger;
}

/** Feishu chats: receives messages over WebSocket and streams replies as cards. */
export class FeishuChannel implements Channel {
  readonly id = "feishu" as const;
  private readonly streamer: FeishuSessionStreamer;
  private readonly closeWatchers = new Map<string, () => void>();
  private ws?: FeishuWSAdapter;

  constructor(
    private readonly config: FeishuClientConfig,
    private readonly deps: FeishuChannelDeps,
    private readonly client = new FeishuClient(config, deps.logger),
  ) {
    this.streamer = new FeishuSessionStreamer(deps.eventHub, client, deps.logger);
  }

  beforeTurn(envelope: InboundEnvelope, session: SessionRoute): () => void {
    const chatId = envelope.conversation.conversationId;
    const rootId = replyRoot(envelope);
    this.streamer.ensureSession({
      sessionId: session.sessionId,
      chatId,
      projectId: session.projectId,
      source: "feishu",
    });
    this.watchClose(session.sessionId, chatId, rootId);
    const turn = { chatId, rootId, projectId: session.projectId };
    this.streamer.enqueueTurn(session.sessionId, turn);
    return () => this.streamer.discardTurn(session.sessionId, turn);
  }

  async afterCommand(
    envelope: InboundEnvelope,
    command: InboundCommand,
    session: SessionRoute | undefined,
  ): Promise<void> {
    // A closed session is confirmed by the close watcher once its resources are released.
    if (command !== "cancel") return;
    await this.client
      .sendCard({
        receiveId: envelope.conversation.conversationId,
        rootId: replyRoot(envelope),
        card: buildFeishuCard({
          title: "会话",
          headerTemplate: "grey",
          statusLine: session ? "当前任务已取消" : "无活跃会话",
          isFinished: true,
        }),
      })
      .catch((error) =>
        this.deps.logger.warn("failed to send Feishu cancel confirmation card", { error }),
      );
  }

  async start(onMessage: InboundSink): Promise<void> {
    const { appId, appSecret } = this.config;
    this.ws = new FeishuWSAdapter({ appId, appSecret }, onMessage, this.deps.logger);
    await this.ws.start();
  }

  async stop(): Promise<void> {
    this.ws?.stop();
    await this.streamer.stop();
    for (const unsubscribe of this.closeWatchers.values()) unsubscribe();
    this.closeWatchers.clear();
  }

  /** Tells the chat when the session closes, however it was closed. */
  private watchClose(sessionId: string, chatId: string, rootId: string): void {
    if (this.closeWatchers.has(sessionId)) return;
    const unsubscribe = this.deps.sessionManager.observe(async (event) => {
      if (event.type !== "destroyed" || event.session.sessionId !== sessionId) return;
      this.closeWatchers.delete(sessionId);
      unsubscribe();
      await this.streamer.closeSession(sessionId);
      await this.client
        .sendCard({
          receiveId: chatId,
          receiveIdType: "chat_id",
          rootId,
          card: buildFeishuCard({
            title: "✅ 会话已关闭",
            headerTemplate: "grey",
            statusLine: "已退出会话",
            contentMarkdown:
              "当前会话已成功关闭，相关的 Git 工作区与进程资源已安全释放。\n\n如需开启新的任务，请直接发送具体需求。",
            isFinished: true,
          }),
        })
        .catch((error) =>
          this.deps.logger.warn("failed to send Feishu session close card", { sessionId, error }),
        );
    });
    this.closeWatchers.set(sessionId, unsubscribe);
  }
}

/** Replies go into the message's thread, or start one under the message itself. */
function replyRoot(envelope: InboundEnvelope): string {
  return envelope.conversation.threadId || envelope.messageId;
}
