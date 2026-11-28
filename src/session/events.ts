import { randomUUID } from "node:crypto";
import { isTransientEvent } from "../domain/events.ts";
import type { EventRecord, SessionRoute } from "../domain/types.ts";
import type { EventHub } from "../events/hub.ts";
import type { Store } from "../persistence/store.ts";

export type SessionRef = Pick<SessionRoute, "projectId" | "sessionId">;

/**
 * Writes a session's event log. Events of one session are written one at a time and numbered in
 * order; transient events are published without being stored.
 */
export class SessionEvents {
  private readonly writes = new Map<string, Promise<unknown>>();
  private readonly sequences = new Map<string, number>();

  constructor(
    private readonly store: Store,
    private readonly hub: EventHub,
  ) {}

  emit(
    session: SessionRef,
    type: EventRecord["type"],
    runtime: EventRecord["runtime"],
    payload: unknown,
  ): Promise<EventRecord> {
    const previous = this.writes.get(session.sessionId) ?? Promise.resolve();
    const write = previous.then(() => this.write(session, type, runtime, payload));
    this.writes.set(
      session.sessionId,
      write.catch(() => {}),
    );
    return write;
  }

  list(sessionId: string, after = 0): Promise<EventRecord[]> {
    return this.store.listEvents(sessionId, after);
  }

  /** Drops what is kept for a session that is gone. */
  forget(sessionId: string): void {
    this.writes.delete(sessionId);
    this.sequences.delete(sessionId);
  }

  private async write(
    session: SessionRef,
    type: EventRecord["type"],
    runtime: EventRecord["runtime"],
    payload: unknown,
  ): Promise<EventRecord> {
    const { sessionId } = session;
    const sequence =
      (this.sequences.get(sessionId) ?? (await this.store.getLatestEventSequence(sessionId))) + 1;
    this.sequences.set(sessionId, sequence);
    const turnId = turnIdOf(payload);
    const record: EventRecord = {
      id: `evt_${randomUUID()}`,
      projectId: session.projectId,
      sessionId,
      sequence,
      type,
      runtime,
      ...(turnId ? { turnId } : {}),
      payload,
      createdAt: new Date().toISOString(),
      schemaVersion: 1,
    };
    if (!isTransientEvent(type)) await this.store.appendEvent(record);
    this.hub.publish(record);
    return record;
  }
}

function turnIdOf(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const { turnId } = payload as { turnId?: unknown };
  return typeof turnId === "string" ? turnId : undefined;
}
