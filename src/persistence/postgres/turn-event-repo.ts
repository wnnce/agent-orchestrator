import { and, asc, desc, eq, gt, max, sql } from "drizzle-orm";
import type {
  ArtifactRecord,
  EventRecord,
  SessionUsageSummary,
  TurnRecord,
  TurnUsage,
  TurnUsageDetails,
} from "../../domain/types.ts";
import type { DrizzleDatabase } from "../db.ts";
import { artifacts, events, turns, type NewTurnRow } from "../schema.ts";
import type { TurnPatch } from "../types.ts";
import { toArtifactRecord, toEventRecord, toTurnRecord } from "./mappers.ts";

function buildUsageDetails(usage: TurnUsage): TurnUsageDetails | null {
  const details: {
    byModel?: TurnUsageDetails["byModel"];
    contextUsedTokens?: number;
    contextWindowTokens?: number;
  } = {};
  if (usage.byModel !== undefined && usage.byModel.length > 0) {
    details.byModel = usage.byModel;
  }
  if (usage.contextUsedTokens !== undefined) {
    details.contextUsedTokens = usage.contextUsedTokens;
  }
  if (usage.contextWindowTokens !== undefined) {
    details.contextWindowTokens = usage.contextWindowTokens;
  }
  return Object.keys(details).length > 0 ? details : null;
}

function usageColumns(usage: TurnUsage): Partial<NewTurnRow> {
  return {
    model: usage.model ?? null,
    inputTokens: usage.inputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    totalTokens: usage.totalTokens,
    usageDetails: buildUsageDetails(usage),
  };
}

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
      ...(turn.usage ? usageColumns(turn.usage) : {}),
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
    if (patch.usage !== undefined) Object.assign(updates, usageColumns(patch.usage));
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

  async getSessionUsage(sessionId: string): Promise<SessionUsageSummary | null> {
    const aggRows = await this.db
      .select({
        turnCount: sql<number>`count(*)::int`,
        inputTokens: sql<string | number>`coalesce(sum(${turns.inputTokens}), 0)`,
        cacheReadTokens: sql<string | number>`coalesce(sum(${turns.cacheReadTokens}), 0)`,
        cacheWriteTokens: sql<string | number>`coalesce(sum(${turns.cacheWriteTokens}), 0)`,
        outputTokens: sql<string | number>`coalesce(sum(${turns.outputTokens}), 0)`,
        reasoningTokens: sql<string | number>`coalesce(sum(${turns.reasoningTokens}), 0)`,
        totalTokens: sql<string | number>`coalesce(sum(${turns.totalTokens}), 0)`,
      })
      .from(turns)
      .where(and(eq(turns.sessionId, sessionId), gt(turns.totalTokens, 0)));

    const agg = aggRows[0];
    const turnCount = Number(agg?.turnCount ?? 0);
    if (!agg || turnCount === 0) return null;

    const latestRows = await this.db
      .select({
        model: turns.model,
        usageDetails: turns.usageDetails,
      })
      .from(turns)
      .where(and(eq(turns.sessionId, sessionId), gt(turns.totalTokens, 0)))
      .orderBy(desc(turns.createdAt), desc(turns.id))
      .limit(1);

    const latest = latestRows[0];
    const details = latest?.usageDetails;
    return {
      turnCount,
      inputTokens: Number(agg.inputTokens ?? 0),
      cacheReadTokens: Number(agg.cacheReadTokens ?? 0),
      cacheWriteTokens: Number(agg.cacheWriteTokens ?? 0),
      outputTokens: Number(agg.outputTokens ?? 0),
      reasoningTokens: Number(agg.reasoningTokens ?? 0),
      totalTokens: Number(agg.totalTokens ?? 0),
      ...(latest?.model ? { lastModel: latest.model } : {}),
      ...(details?.contextUsedTokens !== undefined
        ? { contextUsedTokens: details.contextUsedTokens }
        : {}),
      ...(details?.contextWindowTokens !== undefined
        ? { contextWindowTokens: details.contextWindowTokens }
        : {}),
    };
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
