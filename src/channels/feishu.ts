import type { InboundEnvelope, HttpChannelAdapter } from "./types.ts";
import type { Logger } from "../observability/logger.ts";

export * from "./feishu/index.ts";

export interface FeishuAdapterConfig {
  enabled: boolean;
  verificationToken?: string;
}

type EnvelopeHandler = (envelope: InboundEnvelope) => Promise<unknown>;

const object = (value: unknown): Record<string, any> =>
  typeof value === "object" && value !== null ? (value as Record<string, any>) : {};

/** Feishu HTTP event callback adapter. It owns Feishu payloads and ACK semantics. */
export class FeishuAdapter implements HttpChannelAdapter {
  readonly id = "feishu" as const;

  constructor(
    private readonly config: FeishuAdapterConfig,
    private readonly onEnvelope: EnvelopeHandler,
    private readonly logger: Logger,
  ) {}

  async handle(request: Request): Promise<Response> {
    if (!this.config.enabled) return Response.json({ error: "feishu_disabled" }, { status: 404 });
    if (!this.config.verificationToken) {
      return Response.json({ error: "feishu_verification_token_not_configured" }, { status: 503 });
    }
    if (request.method !== "POST")
      return Response.json({ error: "method_not_allowed" }, { status: 405 });

    const body = object(await request.json().catch(() => ({})));
    if (body.type === "url_verification") return this.handleVerification(body);

    const header = object(body.header);
    if (this.config.verificationToken && header.token !== this.config.verificationToken) {
      return Response.json({ error: "invalid_feishu_token" }, { status: 401 });
    }

    if (header.event_type !== "im.message.receive_v1") return Response.json({ code: 0 });
    const envelope = this.parseMessage(body);
    if (!envelope) return Response.json({ code: 0 });

    try {
      await this.onEnvelope(envelope);
    } catch (error) {
      this.logger.error("Feishu inbox admission failed", { messageId: envelope.messageId, error });
      return Response.json({ error: "inbox_unavailable" }, { status: 503 });
    }
    return Response.json({ code: 0 });
  }

  private handleVerification(body: Record<string, any>): Response {
    if (this.config.verificationToken && body.token !== this.config.verificationToken) {
      return Response.json({ error: "invalid_feishu_token" }, { status: 401 });
    }
    if (typeof body.challenge !== "string" || !body.challenge) {
      return Response.json({ error: "challenge_required" }, { status: 400 });
    }
    return Response.json({ challenge: body.challenge });
  }

  private parseMessage(body: Record<string, any>): InboundEnvelope | undefined {
    const header = object(body.header);
    const event = object(body.event);
    const message = object(event.message);
    if (message.message_type !== "text") return undefined;
    if (object(event.sender).sender_type === "app") return undefined;

    const messageId = String(message.message_id ?? header.event_id ?? "").trim();
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
    const text = typeof content.text === "string" ? content.text.trim() : "";
    if (!text) return undefined;

    const sender = object(event.sender);
    const senderId = object(sender.sender_id);
    const threadId = String(message.thread_id ?? message.root_id ?? "").trim();
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
      metadata: { eventId: header.event_id, chatType: message.chat_type },
    };
  }
}
