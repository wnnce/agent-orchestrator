import type {
  ChannelHooks,
  ChannelId,
  InboundCommand,
  InboundEnvelope,
  InboundResult,
} from "../channels/types.ts";
import { ConflictError, ValidationError } from "../domain/errors.ts";
import type { SessionRoute } from "../domain/types.ts";
import type { Logger } from "../observability/logger.ts";
import { SpanKind, withSpan } from "../observability/tracing.ts";
import type { Store } from "../persistence/store.ts";
import type { ProjectManager } from "../project/manager.ts";
import { MemoryInbox } from "./inbox.ts";
import type { SessionService } from "./sessions.ts";

export interface InboundServiceDeps {
  readonly store: Store;
  readonly projects: ProjectManager;
  readonly sessions: SessionService;
  readonly channels: readonly ChannelHooks[];
  readonly logger: Logger;
}

/**
 * Messages arriving from chats and webhooks. Each external conversation maps to one session;
 * messages are processed once each, in order per conversation, and `/cancel` or `/close`
 * act on the conversation's session instead of reaching the agent.
 */
export class InboundService {
  private readonly inbox = new MemoryInbox((envelope) => this.process(envelope));
  private readonly channels: ReadonlyMap<ChannelId, ChannelHooks>;

  constructor(private readonly deps: InboundServiceDeps) {
    this.channels = new Map(deps.channels.map((channel) => [channel.id, channel]));
  }

  /** Queues the message and returns at once; failures are only logged. */
  async accept(envelope: InboundEnvelope): Promise<{ duplicate: boolean }> {
    const receipt = this.inbox.accept(envelope);
    void receipt.completion.catch((error) =>
      this.deps.logger.error("inbox message failed", { messageId: envelope.messageId, error }),
    );
    return { duplicate: receipt.duplicate };
  }

  /** Queues the message and waits until it is processed. */
  handle(envelope: InboundEnvelope): Promise<InboundResult> {
    return this.inbox.accept(envelope).completion;
  }

  /** Stops taking messages and waits for the queued ones. */
  stop(): Promise<void> {
    return this.inbox.stop();
  }

  private process(envelope: InboundEnvelope): Promise<InboundResult> {
    const { channel, conversationId } = envelope.conversation;
    return withSpan(
      `inbound ${channel}`,
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          "messaging.system": channel,
          "messaging.message.id": envelope.messageId,
          "messaging.destination.name": conversationId,
        },
      },
      () => this.dispatch(envelope),
    );
  }

  private async dispatch(envelope: InboundEnvelope): Promise<InboundResult> {
    const text = envelope.text.trim();
    if (!text) throw new ValidationError("inbound message text is required");

    const existing = await this.findSession(envelope);
    const { channel, conversationId, threadId } = envelope.conversation;
    const claimed = await this.deps.store.claimInboundMessage({
      messageId: envelope.messageId,
      channel,
      conversationId,
      ...(threadId ? { threadId } : {}),
      ...(existing ? { sessionId: existing.sessionId } : {}),
      receivedAt: envelope.receivedAt,
    });
    if (!claimed) return this.duplicate(envelope, existing);

    const command = parseCommand(text);
    return command
      ? this.runCommand(envelope, command, existing)
      : this.submit(envelope, text, existing);
  }

  /** A message seen before: report the session it went to. */
  private async duplicate(
    envelope: InboundEnvelope,
    existing: SessionRoute | undefined,
  ): Promise<InboundResult> {
    const session = existing ?? (await this.findSession(envelope));
    if (!session) throw new ConflictError("duplicate inbound message is still being processed");
    this.deps.logger.info("duplicate inbound message ignored", {
      channel: envelope.conversation.channel,
      messageId: envelope.messageId,
      sessionId: session.sessionId,
    });
    return { duplicate: true, session };
  }

  private async runCommand(
    envelope: InboundEnvelope,
    { name, argument }: ParsedCommand,
    session: SessionRoute | undefined,
  ): Promise<InboundResult> {
    if (session) {
      const runtime = this.deps.projects.get(session.projectId);
      await this.releaseOnFailure(envelope, () =>
        name === "cancel"
          ? runtime.turns.interrupt(session.sessionId, argument)
          : runtime.sessions.close(session.sessionId),
      );
      if (name === "close") {
        this.deps.logger.info("session closed via /close command", {
          channel: envelope.conversation.channel,
          sessionId: session.sessionId,
          conversationId: envelope.conversation.conversationId,
        });
      }
    }
    await this.channels.get(envelope.conversation.channel)?.afterCommand(envelope, name, session);
    return { duplicate: false, command: name, ...(session ? { session } : {}) };
  }

  /** Submits the message as a turn, opening a session for the conversation if it has none. */
  private async submit(
    envelope: InboundEnvelope,
    text: string,
    existing: SessionRoute | undefined,
  ): Promise<InboundResult> {
    let undoReply: (() => void) | undefined;
    const { session, turn } = await this.releaseOnFailure(
      envelope,
      async () => {
        const session =
          existing ??
          (
            await this.deps.sessions.create({
              ...(envelope.projectId ? { projectId: envelope.projectId } : {}),
              query: text,
              submitQuery: false,
              source: envelope.conversation.channel,
              external: envelope.conversation,
            })
          ).session;
        undoReply = this.channels.get(envelope.conversation.channel)?.beforeTurn(envelope, session);
        const turn = await this.deps.sessions.submitTurn(session.sessionId, text);
        return { session, turn };
      },
      () => undoReply?.(),
    );
    this.deps.logger.info("inbound message accepted", {
      channel: envelope.conversation.channel,
      messageId: envelope.messageId,
      sessionId: session.sessionId,
      turnId: turn.id,
    });
    return { duplicate: false, session, turn };
  }

  /** Runs `action`; if it fails, undoes it and releases the message so it can be retried. */
  private async releaseOnFailure<T>(
    envelope: InboundEnvelope,
    action: () => Promise<T>,
    undo?: () => void,
  ): Promise<T> {
    try {
      return await action();
    } catch (error) {
      undo?.();
      await this.deps.store.releaseInboundMessage(envelope.messageId);
      throw error;
    }
  }

  private async findSession(envelope: InboundEnvelope): Promise<SessionRoute | undefined> {
    const { channel, conversationId, threadId } = envelope.conversation;
    return (
      (await this.deps.store.findSessionByExternal(channel, conversationId, threadId)) ?? undefined
    );
  }
}

interface ParsedCommand {
  readonly name: InboundCommand;
  /** For `/cancel`, the turn to cancel. */
  readonly argument?: string | undefined;
}

function parseCommand(text: string): ParsedCommand | undefined {
  if (/^\/cancel(?:\s|$)/i.test(text)) return { name: "cancel", argument: text.split(/\s+/)[1] };
  if (text.toLowerCase() === "/close") return { name: "close" };
  return undefined;
}
