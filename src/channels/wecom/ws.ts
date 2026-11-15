import type { InboundEnvelope } from "../types.ts";
import type { Logger } from "../../observability/logger.ts";
import { WeComClient } from "./client.ts";

type EnvelopeHandler = (envelope: InboundEnvelope) => Promise<unknown>;

/**
 * WeCom WebSocket persistent connection adapter.
 * Listens for user text messages from enterprise WeChat and translates to InboundEnvelope.
 */
export class WeComWSAdapter {
  private isRunning = false;

  constructor(
    private readonly client: WeComClient,
    private readonly onEnvelope: EnvelopeHandler,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    if (!this.client.isConfigured()) {
      this.logger.debug("WeComWSAdapter: botId or secret missing, skipping WS connection");
      return;
    }

    if (this.isRunning) return;
    this.isRunning = true;

    this.logger.info("connecting to WeCom via WebSocket persistent connection...");

    this.client.connect(async (frame: any) => {
      const envelope = this.parseWSMessage(frame);
      if (!envelope) return;

      this.logger.info("received WeCom message via WebSocket", {
        messageId: envelope.messageId,
        conversationId: envelope.conversation.conversationId,
        chatType: envelope.metadata?.chatType,
      });

      await this.onEnvelope(envelope).catch((error) => {
        this.logger.error("process WeCom WS inbound message failed", {
          messageId: envelope.messageId,
          conversationId: envelope.conversation.conversationId,
          error: (error as Error).message,
        });
      });
    });
  }

  stop(): void {
    this.client.disconnect();
    this.isRunning = false;
  }

  parseWSMessage(frame: any): InboundEnvelope | undefined {
    const body = frame?.body;
    if (!body || body.msgtype !== "text") return undefined;

    const rawContent = body.text?.content;
    if (typeof rawContent !== "string") return undefined;

    // Clean leading @Robot mention in group chats
    let text = rawContent.replace(/^@\S+\s*/, "").trim();
    if (!text) return undefined;

    const messageId = String(body.msgid ?? frame?.headers?.req_id ?? "").trim();
    const chatType = body.chattype; // "single" | "group"
    const conversationId = String(
      (chatType === "group" ? body.chatid : body.from?.userid) ?? "",
    ).trim();
    if (!messageId || !conversationId) return undefined;

    const senderId = body.from?.userid ? String(body.from.userid) : undefined;
    const reqId = frame?.headers?.req_id ? String(frame.headers.req_id) : undefined;

    return {
      messageId,
      conversation: {
        channel: "wecom",
        conversationId,
      },
      ...(senderId ? { senderId } : {}),
      text,
      receivedAt: new Date().toISOString(),
      metadata: {
        reqId,
        streamId: `stream_${messageId}`,
        chatType,
        aibotId: body.aibotid,
      },
    };
  }
}
