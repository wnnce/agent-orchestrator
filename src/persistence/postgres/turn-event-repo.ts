import { and, asc, desc, eq, gt, max } from "drizzle-orm";
import type { ArtifactRecord, EventRecord, TurnRecord } from "../../domain/types.ts";
import type { DrizzleDatabase } from "../db.ts";
import { artifacts, events, turns, type NewTurnRow } from "../schema.ts";
import type { TurnPatch } from "../types.ts";
import { toArtifactRecord, toEventRecord, toTurnRecord } from "./mappers.ts";

/** Drizzle repository for `turns`, `events`, and `artifacts`. */
export class PostgresTurnEventRepo {
  constructor(private readonly db: DrizzleDatabase) {}

  async createTurn(turn: TurnRecord): Promise<void> {
    await this.db.insert(turns).values({
      turnId: turn.id,
      sessionId: turn.sessionId,
      input: turn.input,
      status: turn.status,
      runtimeTurnId: turn.runtimeTurnId ?? null,
      output: turn.output ?? null,
      error: turn.error ?? null,
      createdAt: new Date(turn.createdAt),
      startedAt: turn.startedAt ? new Date(turn.startedAt) : null,
      finishedAt: turn.finishedAt ? new Date(turn.finishedAt) : null,
    });
  }

  async getTurn(turnId: string): Promise<TurnRecord | null> {
    const rows = await this.db.select().from(turns).where(eq(turns.turnId, turnId)).limit(1);
    return rows[0] ? toTurnRecord(rows[0]) : null;
  }

  async getLatestTurn(sessionId: string): Promise<TurnRecord | null> {
    const rows = await this.db
      .select()
      .from(turns)
      .where(eq(turns.sessionId, sessionId))
      .orderBy(desc(turns.createdAt), desc(turns.id))
      .limit(1);
    return rows[0] ? toTurnRecord(rows[0]) : null;
  }

  async updateTurn(turnId: string, patch: TurnPatch): Promise<void> {
    const updates: Partial<NewTurnRow> = {};
    if (patch.status !== undefined) updates.status = patch.status;
    if (patch.runtimeTurnId !== undefined) updates.runtimeTurnId = patch.runtimeTurnId;
    if (patch.output !== undefined) updates.output = patch.output;
    if (patch.error !== undefined) updates.error = patch.error;
    if (patch.startedAt !== undefined) updates.startedAt = new Date(patch.startedAt);
    if (patch.finishedAt !== undefined) updates.finishedAt = new Date(patch.finishedAt);

    if (Object.keys(updates).length === 0) {
      const existing = await this.db
        .select({ id: turns.id })
        .from(turns)
        .where(eq(turns.turnId, turnId))
        .limit(1);
      if (existing.length === 0) throw new Error(`turn not found: ${turnId}`);
      return;
    }

    const updated = await this.db
      .update(turns)
      .set(updates)
      .where(eq(turns.turnId, turnId))
      .returning({ id: turns.id });

    if (updated.length === 0) {
      throw new Error(`turn not found: ${turnId}`);
    }
  }

  async appendEvent(event: EventRecord): Promise<EventRecord> {
    await this.db.insert(events).values({
      eventId: event.id,
      projectId: event.projectId,
      sessionId: event.sessionId,
      turnId: event.turnId ?? null,
      sequence: event.sequence,
      type: event.type,
      runtime: event.runtime,
      payload: event.payload,
      schemaVersion: event.schemaVersion,
      createdAt: new Date(event.createdAt),
    });
    return event;
  }

  async getLatestEventSequence(sessionId: string): Promise<number> {
    const rows = await this.db
      .select({ maxSeq: max(events.sequence) })
      .from(events)
      .where(eq(events.sessionId, sessionId));
    return Number(rows[0]?.maxSeq ?? 0);
  }

  async listEvents(sessionId: string, afterSequence = 0): Promise<EventRecord[]> {
    const rows = await this.db
      .select()
      .from(events)
      .where(and(eq(events.sessionId, sessionId), gt(events.sequence, afterSequence)))
      .orderBy(asc(events.sequence));
    return rows.map(toEventRecord);
  }

  async addArtifact(artifact: ArtifactRecord): Promise<void> {
    await this.db.insert(artifacts).values({
      artifactId: artifact.id,
      projectId: artifact.projectId,
      sessionId: artifact.sessionId,
      turnId: artifact.turnId ?? null,
      kind: artifact.kind,
      path: artifact.path,
      contentType: artifact.contentType,
      sizeBytes: artifact.sizeBytes,
      createdAt: new Date(artifact.createdAt),
    });
  }

  async listArtifacts(sessionId: string): Promise<ArtifactRecord[]> {
    const rows = await this.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.sessionId, sessionId))
      .orderBy(asc(artifacts.createdAt));
    return rows.map(toArtifactRecord);
  }
}
