import type { SessionRoute } from "../../domain/types.ts";
import type { EventHub } from "../../events/hub.ts";
import type { Logger } from "../../observability/logger.ts";
import type { SessionManager } from "../../session/index.ts";
import type { Channel, InboundCommand, InboundEnvelope, InboundSink } from "../types.ts";
import { buildWeComCancelMessage, buildWeComCloseMessage } from "./card.ts";
import { WeComClient, type WeComClientConfig } from "./client.ts";
import { WeComSessionStreamer, type WeComTurnContext } from "./streamer.ts";
import { WeComWSAdapter } from "./ws.ts";

export interface WeComChannelDeps {
  readonly eventHub: EventHub;
  readonly sessionManager: SessionManager;
  readonly logger: Logger;
}

/** WeCom chats: receives messages over WebSocket and streams replies as Markdown. */
export class WeComChannel implements Channel {
  readonly id = "wecom" as const;
  private readonly streamer: WeComSessionStreamer;
  private readonly closeWatchers = new Map<string, () => void>();
  private ws?: WeComWSAdapter;

  constructor(
    config: WeComClientConfig,
    private readonly deps: WeComChannelDeps,
    private readonly client = new WeComClient(config, deps.logger),
  ) {
    this.streamer = new WeComSessionStreamer(deps.eventHub, client, deps.logger);
  }

  beforeTurn(envelope: InboundEnvelope, session: SessionRoute): () => void {
    const chatId = envelope.conversation.conversationId;
    const reqId = requestId(envelope);
    this.streamer.ensureSession({
      sessionId: session.sessionId,
      chatId,
      projectId: session.projectId,
      source: "wecom",
    });
    this.watchClose(session.sessionId, chatId);
    const turn: WeComTurnContext = {
      chatId,
      ...(reqId ? { reqId } : {}),
      streamId: streamId(envelope),
      projectId: session.projectId,
    };
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
    const message = buildWeComCancelMessage(Boolean(session));
    const reqId = requestId(envelope);
    const sent = reqId
      ? this.client.replyStream(reqId, streamId(envelope), message, true)
      : this.client.sendMessage(envelope.conversation.conversationId, {
          msgtype: "markdown",
          markdown: { content: message },
        });
    await sent.catch((error) =>
      this.deps.logger.warn("failed to send WeCom cancel confirmation", { error }),
    );
  }

  async start(onMessage: InboundSink): Promise<void> {
    this.ws = new WeComWSAdapter(this.client, onMessage, this.deps.logger);
    await this.ws.start();
  }

  async stop(): Promise<void> {
    this.ws?.stop();
    await this.streamer.stop();
    for (const unsubscribe of this.closeWatchers.values()) unsubscribe();
    this.closeWatchers.clear();
  }

  /** Tells the chat when the session closes, however it was closed. */
  private watchClose(sessionId: string, chatId: string): void {
    if (this.closeWatchers.has(sessionId)) return;
    const unsubscribe = this.deps.sessionManager.observe(async (event) => {
      if (event.type !== "destroyed" || event.session.sessionId !== sessionId) return;
      this.closeWatchers.delete(sessionId);
      unsubscribe();
      await this.streamer.closeSession(sessionId);
      await this.client
        .sendMessage(chatId, {
          msgtype: "markdown",
          markdown: { content: buildWeComCloseMessage() },
        })
        .catch((error) =>
          this.deps.logger.warn("failed to send WeCom session close message", {
            sessionId,
            error: (error as Error).message,
          }),
        );
    });
    this.closeWatchers.set(sessionId, unsubscribe);
  }
}

/** The WeCom request a reply can stream into, when the message came with one. */
function requestId(envelope: InboundEnvelope): string | undefined {
  return envelope.metadata?.reqId ? String(envelope.metadata.reqId) : undefined;
}

function streamId(envelope: InboundEnvelope): string {
  return String(envelope.metadata?.streamId ?? `stream_${envelope.messageId}`);
}
