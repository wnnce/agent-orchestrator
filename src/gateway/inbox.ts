import type { InboundEnvelope, InboundResult } from "../channels/types.ts";

export type InboxStatus = "queued" | "dispatched" | "completed" | "failed" | "canceled";
export interface InboxRecord {
  key: string;
  envelope: InboundEnvelope;
  status: InboxStatus;
  sessionId?: string;
  turnId?: string;
  error?: string;
  result: Promise<InboundResult>;
}
export function conversationKey(envelope: InboundEnvelope): string {
  return JSON.stringify([
    envelope.conversation.channel,
    envelope.conversation.instanceId ?? "default",
    envelope.conversation.conversationId,
    envelope.conversation.threadId ?? "",
  ]);
}
export class MemoryInbox {
  private readonly records = new Map<string, InboxRecord>();
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly running = new Map<string, Promise<unknown>>();
  private accepting = true;
  constructor(
    private readonly dispatch: (envelope: InboundEnvelope) => Promise<InboundResult>,
    private readonly limit = 256,
    private readonly retained = 4096,
  ) {}
  accept(envelope: InboundEnvelope): { duplicate: boolean; completion: Promise<InboundResult> } {
    if (!this.accepting) throw new Error("inbox is stopping");
    const key = JSON.stringify([
      envelope.conversation.channel,
      envelope.conversation.instanceId ?? "default",
      envelope.messageId,
    ]);
    const existing = this.records.get(key);
    if (existing && existing.status !== "failed")
      return {
        duplicate: true,
        completion: existing.result.then((result) => ({ ...result, duplicate: true })),
      };
    const control = /^\/(cancel|close)(?:\s|$)/i.test(envelope.text.trim());
    const queued = [...this.records.values()].filter(
      (r) => r.status === "queued" || r.status === "dispatched",
    ).length;
    if (!control && queued >= this.limit) throw new Error("inbox is full");
    const conversation = conversationKey(envelope);
    const previous =
      (control ? this.running.get(conversation) : this.tails.get(conversation)) ??
      Promise.resolve();
    const record: InboxRecord = {
      key,
      envelope: structuredClone(envelope),
      status: "queued",
      result: Promise.resolve(null as any),
    };
    const result = previous
      .catch(() => {})
      .then(async () => {
        if (record.status === "canceled") throw new Error("message canceled by session close");
        record.status = "dispatched";
        this.running.set(conversation, result);
        try {
          if (/^\/close$/i.test(envelope.text.trim())) {
            for (const candidate of this.records.values())
              if (
                candidate !== record &&
                candidate.status === "queued" &&
                conversationKey(candidate.envelope) === conversation
              )
                candidate.status = "canceled";
          }
          const response = await this.dispatch(record.envelope);
          record.sessionId = response.session.sessionId;
          if (response.turn) record.turnId = response.turn.id;
          record.status = "completed";
          return response;
        } catch (error) {
          record.status = "failed";
          record.error = String(error);
          throw error;
        } finally {
          if (this.running.get(conversation) === result) this.running.delete(conversation);
          if (this.tails.get(conversation) === result) this.tails.delete(conversation);
        }
      });
    record.result = result;
    // Observe failures immediately; the caller can also await completion.
    void result.catch(() => {});
    this.records.set(key, record);
    if (!control) {
      this.tails.set(conversation, result);
      if (!this.running.has(conversation)) this.running.set(conversation, result);
    }
    this.prune();
    return { duplicate: false, completion: result };
  }
  private prune(): void {
    for (const [key, record] of this.records) {
      if (this.records.size <= this.retained) break;
      if (
        record.status === "completed" ||
        record.status === "failed" ||
        record.status === "canceled"
      )
        this.records.delete(key);
    }
  }
  snapshot(): Array<Omit<InboxRecord, "result">> {
    return [...this.records.values()].map(({ result: _, ...record }) => structuredClone(record));
  }
  async stop(): Promise<void> {
    this.accepting = false;
    await Promise.allSettled([...this.records.values()].map((r) => r.result));
  }
}
