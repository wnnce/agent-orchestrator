import type {
  ListPipelineActionsFilter,
  ListPipelineNodeLogsFilter,
  ListPipelineRunsFilter,
  NewPipelineNodeRun,
  PipelineActionRecord,
  PipelineNodeLogRecord,
  PipelineNodeRunPatch,
  PipelineNodeRunRecord,
  PipelineNodeRunStatus,
  PipelineRevisionRecord,
  PipelineRunRecord,
  PipelineRunWorkspacePatch,
  PipelineTransitionResult,
  PipelineTransitionWrite,
  PipelineVersionRunCounts,
} from "../../pipeline/types.ts";
import { isActivePipelineRunStatus } from "../../pipeline/types.ts";
import { clampLimit, type PipelineStore } from "../types.ts";

/**
 * In-memory pipeline store. Records go through a JSON round trip on the way in, like they do in
 * PostgreSQL's jsonb columns, so tests see the same shapes production does.
 */
export class MemoryPipelineStore implements PipelineStore {
  private readonly revisions: PipelineRevisionRecord[] = [];
  private readonly runs = new Map<string, PipelineRunRecord>();
  private readonly nodeRuns = new Map<string, PipelineNodeRunRecord>();
  private readonly actionRecords = new Map<string, PipelineActionRecord[]>();
  private readonly nodeLogs = new Map<string, PipelineNodeLogRecord[]>();
  private nextId = 0;

  async createRevision(revision: PipelineRevisionRecord): Promise<PipelineRevisionRecord> {
    const exists = this.revisions.some(
      (r) =>
        r.projectId === revision.projectId &&
        r.pipelineId === revision.pipelineId &&
        r.version === revision.version,
    );
    if (exists) {
      throw new Error(
        `pipeline revision already exists: ${revision.projectId}/${revision.pipelineId}@v${revision.version}`,
      );
    }
    const stored = { ...copy(revision), id: ++this.nextId };
    this.revisions.push(stored);
    return copy(stored);
  }

  async getRevision(
    projectId: string,
    pipelineId: string,
    version: number,
  ): Promise<PipelineRevisionRecord | null> {
    const found = this.revisions.find(
      (r) => r.projectId === projectId && r.pipelineId === pipelineId && r.version === version,
    );
    return found ? copy(found) : null;
  }

  async getLatestRevision(
    projectId: string,
    pipelineId: string,
  ): Promise<PipelineRevisionRecord | null> {
    return (await this.listRevisions(projectId, pipelineId))[0] ?? null;
  }

  async listRevisions(projectId: string, pipelineId: string): Promise<PipelineRevisionRecord[]> {
    return this.revisions
      .filter((r) => r.projectId === projectId && r.pipelineId === pipelineId)
      .sort((a, b) => b.version - a.version)
      .map(copy);
  }

  async createRun(
    run: PipelineRunRecord,
    firstNodeRun: NewPipelineNodeRun,
  ): Promise<PipelineRunRecord> {
    if (
      run.externalKey &&
      (await this.findRunByExternalKey(run.projectId, run.pipelineId, run.externalKey))
    ) {
      throw new Error(
        `duplicate pipeline externalKey: ${run.projectId}/${run.pipelineId}/${run.externalKey}`,
      );
    }
    const stored = { ...copy(run), id: ++this.nextId };
    this.runs.set(run.runId, stored);
    this.insertNodeRun(firstNodeRun);
    return copy(stored);
  }

  async getRun(runId: string): Promise<PipelineRunRecord | null> {
    const found = this.runs.get(runId);
    return found ? copy(found) : null;
  }

  async findRunByExternalKey(
    projectId: string,
    pipelineId: string,
    externalKey: string,
  ): Promise<PipelineRunRecord | null> {
    for (const run of this.runs.values()) {
      if (
        run.projectId === projectId &&
        run.pipelineId === pipelineId &&
        run.externalKey === externalKey
      ) {
        return copy(run);
      }
    }
    return null;
  }

  async listRuns(filter?: ListPipelineRunsFilter): Promise<PipelineRunRecord[]> {
    const limit = clampLimit(filter?.limit, 50, 201);
    const beforeId =
      filter?.beforeId !== undefined && filter.beforeId > 0 ? Math.trunc(filter.beforeId) : 0;
    return [...this.runs.values()]
      .filter(
        (run) =>
          (!filter?.projectId || run.projectId === filter.projectId) &&
          (!filter?.pipelineId || run.pipelineId === filter.pipelineId) &&
          (filter?.version === undefined || run.pipelineVersion === filter.version) &&
          (!filter?.nodeId || run.currentNodeId === filter.nodeId) &&
          (!filter?.status || run.status === filter.status) &&
          (!beforeId || (run.id ?? 0) < beforeId),
      )
      .sort((a, b) => (b.id ?? 0) - (a.id ?? 0))
      .slice(0, limit)
      .map(copy);
  }

  async countRunsByVersion(
    projectId: string,
    pipelineId: string,
  ): Promise<PipelineVersionRunCounts[]> {
    const counts = new Map<number, { active: number; total: number }>();
    for (const run of this.runs.values()) {
      if (run.projectId !== projectId || run.pipelineId !== pipelineId) continue;
      const entry = counts.get(run.pipelineVersion) ?? { active: 0, total: 0 };
      entry.total += 1;
      if (isActivePipelineRunStatus(run.status)) entry.active += 1;
      counts.set(run.pipelineVersion, entry);
    }
    return [...counts.entries()]
      .sort(([a], [b]) => b - a)
      .map(([version, c]) => ({ version, activeRunCount: c.active, totalRunCount: c.total }));
  }

  async updateRunWorkspace(runId: string, patch: PipelineRunWorkspacePatch): Promise<void> {
    const existing = this.runs.get(runId);
    if (!existing) return;
    this.runs.set(runId, { ...existing, ...copy(patch), updatedAt: now() });
  }

  async commitTransition(write: PipelineTransitionWrite): Promise<PipelineTransitionResult> {
    const run = this.runs.get(write.runId);
    if (!run || run.stateVersion !== write.expectedStateVersion) return { status: "conflict" };

    if (write.capacity) {
      const { projectId, pipelineId, nodeId, limit } = write.capacity;
      let running = 0;
      for (const nr of this.nodeRuns.values()) {
        if (
          nr.projectId === projectId &&
          nr.pipelineId === pipelineId &&
          nr.nodeId === nodeId &&
          nr.status === "running"
        ) {
          running += 1;
        }
      }
      if (running >= limit) return { status: "no_capacity" };
    }

    const timestamp = now();
    const { clearStatusSummary, ...runFields } = write.runPatch;
    const nextRun: PipelineRunRecord = {
      ...run,
      ...copy(runFields),
      stateVersion: run.stateVersion + 1,
      updatedAt: timestamp,
    };
    if (clearStatusSummary) delete (nextRun as { statusSummary?: string }).statusSummary;
    this.runs.set(run.runId, nextRun);

    let record: PipelineActionRecord | undefined;
    if (write.record) {
      const list = this.actionRecords.get(run.runId) ?? [];
      const sequence = list.reduce((max, r) => Math.max(max, r.sequence), 0) + 1;
      record = { ...copy(write.record), id: ++this.nextId, sequence };
      list.push(record);
      this.actionRecords.set(run.runId, list);
    }

    if (write.nodeRunPatch) {
      const existing = this.nodeRuns.get(write.nodeRunPatch.nodeRunId);
      if (existing) {
        this.nodeRuns.set(
          existing.nodeRunId,
          applyNodeRunPatch(existing, write.nodeRunPatch.patch),
        );
      }
    }
    if (write.newNodeRun) this.insertNodeRun(write.newNodeRun);

    return { status: "committed", run: copy(nextRun), ...(record ? { record: copy(record) } : {}) };
  }

  async getNodeRun(nodeRunId: string): Promise<PipelineNodeRunRecord | null> {
    const found = this.nodeRuns.get(nodeRunId);
    return found ? copy(found) : null;
  }

  async findNodeRunBySession(sessionId: string): Promise<PipelineNodeRunRecord | null> {
    for (const nr of this.nodeRuns.values()) {
      if (nr.sessionId === sessionId) return copy(nr);
    }
    return null;
  }

  async listNodeRuns(runId: string): Promise<PipelineNodeRunRecord[]> {
    return [...this.nodeRuns.values()]
      .filter((nr) => nr.runId === runId)
      .sort((a, b) => a.sequence - b.sequence)
      .map(copy);
  }

  async listNodeRunsByStatus(
    projectId: string,
    statuses: readonly PipelineNodeRunStatus[],
  ): Promise<PipelineNodeRunRecord[]> {
    return [...this.nodeRuns.values()]
      .filter((nr) => nr.projectId === projectId && statuses.includes(nr.status))
      .sort((a, b) => (a.id ?? 0) - (b.id ?? 0))
      .map(copy);
  }

  async listDueNodeRuns(projectId: string, asOf: Date): Promise<PipelineNodeRunRecord[]> {
    return this.waitingWithPoll(projectId)
      .filter((nr) => Date.parse(nr.nextPollAt!) <= asOf.getTime())
      .map(copy);
  }

  async getNextPollAt(projectId: string): Promise<string | null> {
    return this.waitingWithPoll(projectId)[0]?.nextPollAt ?? null;
  }

  async updateNodeRunProgress(
    nodeRunId: string,
    patch: Pick<PipelineNodeRunPatch, "sessionId" | "agentTurnId" | "stepState">,
  ): Promise<void> {
    const existing = this.nodeRuns.get(nodeRunId);
    if (!existing) return;
    this.nodeRuns.set(nodeRunId, applyNodeRunPatch(existing, patch));
  }

  async listActionRecords(
    runId: string,
    filter?: ListPipelineActionsFilter,
  ): Promise<PipelineActionRecord[]> {
    const limit = clampLimit(filter?.limit, 200, 1000);
    return (this.actionRecords.get(runId) ?? [])
      .filter(
        (r) =>
          (filter?.afterSequence === undefined || r.sequence > filter.afterSequence) &&
          (!filter?.nodeId || r.nodeId === filter.nodeId) &&
          (!filter?.action || r.action === filter.action),
      )
      .sort((a, b) => a.sequence - b.sequence)
      .slice(0, limit)
      .map(copy);
  }

  async getActionRecord(recordId: string): Promise<PipelineActionRecord | null> {
    for (const list of this.actionRecords.values()) {
      const found = list.find((r) => r.recordId === recordId);
      if (found) return copy(found);
    }
    return null;
  }

  async getLatestActionSequence(runId: string): Promise<number> {
    return (this.actionRecords.get(runId) ?? []).reduce((max, r) => Math.max(max, r.sequence), 0);
  }

  async appendNodeLogs(logs: readonly PipelineNodeLogRecord[]): Promise<void> {
    for (const entry of logs) {
      const list = this.nodeLogs.get(entry.nodeRunId) ?? [];
      list.push({ ...copy(entry), id: ++this.nextId });
      this.nodeLogs.set(entry.nodeRunId, list);
    }
  }

  async listNodeLogs(
    nodeRunId: string,
    filter?: ListPipelineNodeLogsFilter,
  ): Promise<PipelineNodeLogRecord[]> {
    const limit = clampLimit(filter?.limit, 200, 1000);
    const afterSequence = filter?.afterSequence ?? 0;
    return (this.nodeLogs.get(nodeRunId) ?? [])
      .filter(
        (entry) =>
          entry.sequence > afterSequence && (!filter?.level || entry.level === filter.level),
      )
      .sort((a, b) => a.sequence - b.sequence)
      .slice(0, limit)
      .map(copy);
  }

  async getLatestNodeLogSequence(nodeRunId: string): Promise<number> {
    return (this.nodeLogs.get(nodeRunId) ?? []).reduce((max, r) => Math.max(max, r.sequence), 0);
  }

  private insertNodeRun(nodeRun: NewPipelineNodeRun): void {
    let sequence = 0;
    let attempt = 0;
    for (const nr of this.nodeRuns.values()) {
      if (nr.runId !== nodeRun.runId) continue;
      sequence = Math.max(sequence, nr.sequence);
      if (nr.nodeId === nodeRun.nodeId) attempt = Math.max(attempt, nr.attempt);
    }
    this.nodeRuns.set(nodeRun.nodeRunId, {
      ...copy(nodeRun),
      id: ++this.nextId,
      sequence: sequence + 1,
      attempt: attempt + 1,
    });
  }

  private waitingWithPoll(projectId: string): PipelineNodeRunRecord[] {
    return [...this.nodeRuns.values()]
      .filter((nr) => nr.projectId === projectId && nr.status === "waiting" && nr.nextPollAt)
      .sort((a, b) => Date.parse(a.nextPollAt!) - Date.parse(b.nextPollAt!));
  }
}

function applyNodeRunPatch(
  existing: PipelineNodeRunRecord,
  patch: PipelineNodeRunPatch,
): PipelineNodeRunRecord {
  const { clearNextPollAt, clearPendingDecision, ...fields } = patch;
  const next: PipelineNodeRunRecord = { ...existing, ...copy(fields), updatedAt: now() };
  if (clearNextPollAt) delete (next as { nextPollAt?: string }).nextPollAt;
  if (clearPendingDecision) delete (next as { pendingDecision?: unknown }).pendingDecision;
  return next;
}

/** Copies a record the way a jsonb column stores it: `undefined` properties are dropped. */
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function now(): string {
  return new Date().toISOString();
}
