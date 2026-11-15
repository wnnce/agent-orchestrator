import * as lark from "@larksuiteoapi/node-sdk";
import type { InboundEnvelope } from "../types.ts";
import type { Logger } from "../../observability/logger.ts";

export interface FeishuWSConfig {
  appId: string;
  appSecret: string;
}

type EnvelopeHandler = (envelope: InboundEnvelope) => Promise<unknown>;

const object = (value: unknown): Record<string, any> =>
  typeof value === "object" && value !== null ? (value as Record<string, any>) : {};

/**
 * Feishu WebSocket persistent connection adapter.
 * Connects directly to Feishu's message gateway using App ID & App Secret.
 * Does NOT require public IP, webhook domain, or verification token.
 */
export class FeishuWSAdapter {
  private client: lark.WSClient | null = null;
  private isRunning = false;

  constructor(
    private readonly config: FeishuWSConfig,
    private readonly onEnvelope: EnvelopeHandler,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    const appId = this.config.appId?.trim();
    const appSecret = this.config.appSecret?.trim();

    if (!appId || !appSecret) {
      this.logger.debug("Feishu WSAdapter: appId or appSecret missing, skipping WS connection");
      return;
    }

    if (this.isRunning) return;
    this.isRunning = true;

    try {
      this.client = new lark.WSClient({
        appId,
        appSecret,
        loggerLevel: lark.LoggerLevel.info,
      });

      const eventDispatcher = new lark.EventDispatcher({});
      eventDispatcher.register({
        "im.message.receive_v1": async (data: any) => {
          this.logger.info("received Feishu message via WebSocket", {
            messageId: data?.message?.message_id,
            chatId: data?.message?.chat_id,
          });

          const envelope = this.parseWSMessage(data);
          if (!envelope) return;

          await this.onEnvelope(envelope).catch((error) => {
            this.logger.error("process Feishu WS inbound message failed", {
              messageId: envelope.messageId,
              conversationId: envelope.conversation.conversationId,
              error,
            });
          });
        },
      });

      this.logger.info("connecting to Feishu via WebSocket persistent connection...", {
        appId,
      });

      await this.client.start({ eventDispatcher });
    } catch (err) {
      this.isRunning = false;
      this.logger.error("failed to start Feishu WebSocket client", {
        error: (err as Error).message,
      });
    }
  }

  stop(): void {
    if (this.client) {
      try {
        this.client.close();
      } catch {}
      this.client = null;
    }
    this.isRunning = false;
  }

  parseWSMessage(data: Record<string, any>): InboundEnvelope | undefined {
    const message = object(data?.message);
    const sender = object(data?.sender);

    if (message.message_type !== "text") return undefined;
    if (sender.sender_type === "app") return undefined;

    const messageId = String(message.message_id ?? "").trim();
    const conversationId = String(message.chat_id ?? "").trim();
    if (!messageId || !conversationId) return undefined;

    let content: Record<string, any> = {};
    if (typeof message.content === "string") {
      try {
        content = object(JSON.parse(message.content));
      } catch {
        this.logger.warn("invalid Feishu text content", { messageId });
      }
    }

    let text = typeof content.text === "string" ? content.text.trim() : "";
    if (!text) return undefined;

    // Clean up @_user_1 or @_user_2 mentions in group chats
    text = text.replace(/@_user_\d+\s*/g, "").trim();
    if (!text) return undefined;

    const senderId = object(sender.sender_id);
    const threadId = String(message.root_id ?? message.parent_id ?? "").trim();

    return {
      messageId,
      conversation: {
        channel: "feishu",
        conversationId,
        ...(threadId ? { threadId } : {}),
      },
      ...(senderId.open_id ? { senderId: String(senderId.open_id) } : {}),
      text,
      receivedAt: new Date().toISOString(),
      metadata: {
        chatType: message.chat_type,
        rootId: message.root_id,
        parentId: message.parent_id,
      },
    };
  }
}
