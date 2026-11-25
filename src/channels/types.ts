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

export interface InboundResult {
  duplicate: boolean;
  session: SessionRoute;
  turn?: TurnRecord;
  command?: string;
}
