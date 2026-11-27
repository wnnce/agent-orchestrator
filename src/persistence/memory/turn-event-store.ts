import type { OriginRef } from "../../domain/origin.ts";
import type {
  ArtifactRecord,
  EventRecord,
  SessionUsageSummary,
  TurnRecord,
} from "../../domain/types.ts";
import type { TurnPatch } from "../types.ts";

/** In-memory repository for `turns`, `events`, and `artifacts`. */
export class MemoryTurnEventStore {
  readonly turns = new Map<string, TurnRecord>();
  readonly events = new Map<string, EventRecord[]>();
  readonly artifacts: ArtifactRecord[] = [];

  async createTurn(turn: TurnRecord): Promise<void> {
    this.turns.set(turn.id, structuredClone(turn));
  }

  async getTurn(turnId: string): Promise<TurnRecord | null> {
    const found = this.turns.get(turnId);
    return found ? structuredClone(found) : null;
  }

  async getLatestTurn(sessionId: string): Promise<TurnRecord | null> {
    let latest: TurnRecord | undefined;
    for (const turn of this.turns.values()) {
      if (turn.sessionId === sessionId) {
        latest = turn;
      }
    }
    return latest ? structuredClone(latest) : null;
  }

  async updateTurn(turnId: string, patch: TurnPatch): Promise<void> {
    const current = this.turns.get(turnId);
    if (!current) throw new Error(`turn not found: ${turnId}`);
    const next: TurnRecord = { ...current };
    if (patch.status !== undefined) next.status = patch.status;
    if (patch.runtimeTurnId !== undefined) next.runtimeTurnId = patch.runtimeTurnId;
    if (patch.output !== undefined) next.output = patch.output;
    if (patch.error !== undefined) next.error = patch.error;
    if (patch.usage !== undefined) next.usage = structuredClone(patch.usage);
    if (patch.startedAt !== undefined) next.startedAt = patch.startedAt;
    if (patch.finishedAt !== undefined) next.finishedAt = patch.finishedAt;
    this.turns.set(turnId, next);
  }

  async getSessionUsage(sessionId: string): Promise<SessionUsageSummary | null> {
    let turnCount = 0;
    let inputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let outputTokens = 0;
    let reasoningTokens = 0;
    let totalTokens = 0;
    let latestTurn: TurnRecord | undefined;

    for (const turn of this.turns.values()) {
      if (turn.sessionId !== sessionId || !turn.usage || turn.usage.totalTokens <= 0) {
        continue;
      }
      turnCount += 1;
      inputTokens += turn.usage.inputTokens;
      cacheReadTokens += turn.usage.cacheReadTokens;
      cacheWriteTokens += turn.usage.cacheWriteTokens;
      outputTokens += turn.usage.outputTokens;
      reasoningTokens += turn.usage.reasoningTokens;
      totalTokens += turn.usage.totalTokens;
      if (!latestTurn || turn.createdAt >= latestTurn.createdAt) {
        latestTurn = turn;
      }
    }

    if (turnCount === 0) return null;
    const latestUsage = latestTurn?.usage;
    return {
      turnCount,
      inputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      outputTokens,
      reasoningTokens,
      totalTokens,
      ...(latestUsage?.model ? { lastModel: latestUsage.model } : {}),
      ...(latestUsage?.contextUsedTokens !== undefined
        ? { contextUsedTokens: latestUsage.contextUsedTokens }
        : {}),
      ...(latestUsage?.contextWindowTokens !== undefined
        ? { contextWindowTokens: latestUsage.contextWindowTokens }
        : {}),
    };
  }

  async appendEvent(event: EventRecord): Promise<EventRecord> {
    const list = this.events.get(event.sessionId) ?? [];
    const stored = structuredClone(event);
    list.push(stored);
    this.events.set(event.sessionId, list);
    return stored;
  }

  async getLatestEventSequence(sessionId: string): Promise<number> {
    const list = this.events.get(sessionId);
    if (!list || list.length === 0) return 0;
    let maxSeq = 0;
    for (const item of list) {
      if (item.sequence > maxSeq) maxSeq = item.sequence;
    }
    return maxSeq;
  }

  async listEvents(sessionId: string, afterSequence = 0): Promise<EventRecord[]> {
    const list = this.events.get(sessionId) ?? [];
    return list
      .filter((event) => event.sequence > afterSequence)
      .sort((a, b) => a.sequence - b.sequence)
      .map((event) => structuredClone(event));
  }

  async addArtifact(artifact: ArtifactRecord): Promise<void> {
    this.artifacts.push(structuredClone(artifact));
  }

  async listArtifacts(origin: OriginRef): Promise<ArtifactRecord[]> {
    return this.artifacts
      .filter((item) => item.originKind === origin.kind && item.originId === origin.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((item) => structuredClone(item));
  }

  deleteBySession(sessionId: string): void {
    this.events.delete(sessionId);
    for (const [turnId, turn] of this.turns) {
      if (turn.sessionId === sessionId) {
        this.turns.delete(turnId);
      }
    }
    for (let i = this.artifacts.length - 1; i >= 0; i--) {
      const artifact = this.artifacts[i];
      if (artifact?.originKind === "session" && artifact.originId === sessionId) {
        this.artifacts.splice(i, 1);
      }
    }
  }
}
