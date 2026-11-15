import { WSClient, type WSClientOptions } from "@wecom/aibot-node-sdk";
import type { Logger } from "../../observability/logger.ts";

export interface WeComClientConfig {
  botId: string;
  secret: string;
  wsUrl?: string;
  heartbeatInterval?: number;
}

/**
 * WeCom AI Bot client wrapper over @wecom/aibot-node-sdk.
 * Manages WebSocket persistent connection to wss://openws.work.weixin.qq.com.
 * Supports streaming response (replyStream) and proactive push (sendMessage).
 */
export class WeComClient {
  private readonly botId: string;
  private readonly secret: string;
  private readonly wsUrl: string | undefined;
  private readonly heartbeatInterval: number;
  private wsClient: WSClient | null = null;
  private isConnected = false;

  constructor(
    config: WeComClientConfig,
    private readonly logger?: Logger,
  ) {
    this.botId = (config.botId ?? "").trim();
    this.secret = (config.secret ?? "").trim();
    this.wsUrl = config.wsUrl ? config.wsUrl.trim() : undefined;
    this.heartbeatInterval = config.heartbeatInterval ?? 30_000;
  }

  isConfigured(): boolean {
    return Boolean(this.botId && this.secret);
  }

  connect(onMessageText?: (frame: any) => Promise<void>): void {
    if (!this.isConfigured()) {
      this.logger?.debug("WeComClient not configured, skipping connect");
      return;
    }
    if (this.wsClient) return;

    const options: WSClientOptions = {
      botId: this.botId,
      secret: this.secret,
      heartbeatInterval: this.heartbeatInterval,
      ...(this.wsUrl ? { wsUrl: this.wsUrl } : {}),
      logger: {
        debug: (msg, ...args) => this.logger?.debug(msg, { args }),
        info: (msg, ...args) => this.logger?.info(msg, { args }),
        warn: (msg, ...args) => this.logger?.warn(msg, { args }),
        error: (msg, ...args) => this.logger?.error(msg, { args }),
      },
    };

    this.wsClient = new WSClient(options);

    this.wsClient.on("connected", () => {
      this.logger?.info("WeCom WebSocket connected to gateway");
    });

    this.wsClient.on("authenticated", () => {
      this.isConnected = true;
      this.logger?.info("WeCom WebSocket authenticated successfully");
    });

    this.wsClient.on("disconnected", (reason) => {
      this.isConnected = false;
      this.logger?.warn("WeCom WebSocket disconnected", { reason });
    });

    this.wsClient.on("error", (err) => {
      this.logger?.error("WeCom WebSocket error", { error: err.message });
    });

    if (onMessageText) {
      this.wsClient.on("message.text", async (frame) => {
        try {
          await onMessageText(frame);
        } catch (err: any) {
          this.logger?.error("Error handling WeCom text message frame", {
            error: err?.message,
          });
        }
      });
    }

    this.wsClient.connect();
  }

  disconnect(): void {
    if (this.wsClient) {
      try {
        this.wsClient.disconnect();
      } catch {}
      this.wsClient = null;
      this.isConnected = false;
    }
  }

  async replyStream(
    reqId: string,
    streamId: string,
    content: string,
    finish: boolean = false,
  ): Promise<void> {
    if (!this.wsClient) throw new Error("WeCom WSClient is not connected");
    const frame = { headers: { req_id: reqId } };
    if (typeof (this.wsClient as any).replyStreamNonBlocking === "function" && !finish) {
      await (this.wsClient as any).replyStreamNonBlocking(frame, streamId, content, finish);
    } else {
      await this.wsClient.replyStream(frame, streamId, content, finish);
    }
  }

  async sendMessage(
    chatId: string,
    body: { msgtype: string; markdown?: { content: string }; template_card?: any },
  ): Promise<void> {
    if (!this.wsClient) throw new Error("WeCom WSClient is not connected");
    await this.wsClient.sendMessage(chatId, body as any);
  }
}
