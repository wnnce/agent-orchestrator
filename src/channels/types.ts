import type { SessionRoute, TurnRecord } from "../domain/types.ts";

export type ChannelId = "http" | "feishu" | "wecom";

export interface ConversationRef {
  channel: ChannelId;
  instanceId?: string;
  conversationId: string;
  threadId?: string;
}

export interface InboundEnvelope {
  messageId: string;
  conversation: ConversationRef;
  senderId?: string;
  text: string;
  projectId?: string;
  receivedAt: string;
  metadata?: Record<string, unknown>;
}

/** A chat command people can send instead of a message for the agent. */
export type InboundCommand = "cancel" | "close";

export interface InboundResult {
  duplicate: boolean;
  /** The conversation's session; absent when a command found no session to act on. */
  session?: SessionRoute;
  turn?: TurnRecord;
  command?: InboundCommand;
}

/** Where a channel hands the messages it receives. */
export type InboundSink = (envelope: InboundEnvelope) => Promise<unknown>;

/** The points in handling an inbound message where its channel takes part. */
export interface ChannelHooks {
  readonly id: ChannelId;
  /**
   * Called before the message is submitted as a turn, to prepare the reply (such as a streaming
   * card). Returns a function that undoes the preparation if submitting fails.
   */
  beforeTurn(envelope: InboundEnvelope, session: SessionRoute): () => void;
  /** Called after a command ran, so the channel can confirm it to the sender. */
  afterCommand(
    envelope: InboundEnvelope,
    command: InboundCommand,
    session: SessionRoute | undefined,
  ): Promise<void>;
}

/** An external chat channel: its inbound connection and its part in handling messages. */
export interface Channel extends ChannelHooks {
  start(onMessage: InboundSink): Promise<void>;
  stop(): Promise<void>;
}
