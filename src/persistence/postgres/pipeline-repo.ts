import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  lt,
  lte,
  max,
  min,
  sql,
} from "drizzle-orm";
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
import type { DrizzleDatabase, DrizzleExecutor } from "../db.ts";
import {
  pipelineActionRecords,
  pipelineNodeLogs,
  pipelineNodeRuns,
  pipelineRevisions,
  pipelineRuns,
  type PipelineActionRecordRow,
  type PipelineNodeLogRow,
  type PipelineNodeRunRow,
  type PipelineRevisionRow,
  type PipelineRunRow,
} from "../schema.ts";
import { clampLimit, type PipelineStore } from "../types.ts";

/** Drizzle ORM repository for the pipeline tables. */
export class PostgresPipelineRepo implements PipelineStore {
  constructor(private readonly db: DrizzleDatabase) {}

  async createRevision(revision: PipelineRevisionRecord): Promise<PipelineRevisionRecord> {
    const [row] = await this.db
      .insert(pipelineRevisions)
      .values({
        projectId: revision.projectId,
        pipelineId: revision.pipelineId,
        version: revision.version,
        topologyHash: revision.topologyHash,
        nodesSnapshot: [...revision.nodesSnapshot],
        createdAt: new Date(revision.createdAt),
      })
      .returning();
    return toRevision(row!);
  }

  async getRevision(
    projectId: string,
    pipelineId: string,
    version: number,
  ): Promise<PipelineRevisionRecord | null> {
    const rows = await this.db
      .select()
      .from(pipelineRevisions)
      .where(
        and(
          eq(pipelineRevisions.projectId, projectId),
          eq(pipelineRevisions.pipelineId, pipelineId),
          eq(pipelineRevisions.version, version),
        ),
      )
      .limit(1);
    return rows[0] ? toRevision(rows[0]) : null;
  }

  async getLatestRevision(
    projectId: string,
    pipelineId: string,
  ): Promise<PipelineRevisionRecord | null> {
    return (await this.listRevisions(projectId, pipelineId, 1))[0] ?? null;
  }

  async listRevisions(
    projectId: string,
    pipelineId: string,
    limit?: number,
  ): Promise<PipelineRevisionRecord[]> {
    const query = this.db
      .select()
      .from(pipelineRevisions)
      .where(
        and(
          eq(pipelineRevisions.projectId, projectId),
          eq(pipelineRevisions.pipelineId, pipelineId),
        ),
      )
      .orderBy(desc(pipelineRevisions.version));
    const rows = limit === undefined ? await query : await query.limit(limit);
    return rows.map(toRevision);
  }

  async createRun(
    run: PipelineRunRecord,
    firstNodeRun: NewPipelineNodeRun,
  ): Promise<PipelineRunRecord> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(pipelineRuns)
        .values({
          runId: run.runId,
          projectId: run.projectId,
          pipelineId: run.pipelineId,
          pipelineVersion: run.pipelineVersion,
          externalKey: run.externalKey ?? null,
          externalUrl: run.externalUrl ?? null,
          title: run.title,
          description: run.description ?? null,
          data: run.data,
          metadata: run.metadata,
          currentNodeId: run.currentNodeId,
          status: run.status,
          workspacePath: run.workspacePath ?? null,
          branchName: run.branchName ?? null,
          workspaceStatus: run.workspaceStatus,
          loopCounts: run.loopCounts,
          statusSummary: run.statusSummary ?? null,
          activeNodeRunId: run.activeNodeRunId ?? null,
          latestNodeOutputs: run.latestNodeOutputs,
          createdBy: run.createdBy,
          stateVersion: run.stateVersion,
          createdAt: new Date(run.createdAt),
          updatedAt: new Date(run.updatedAt),
          finishedAt: run.finishedAt ? new Date(run.finishedAt) : null,
        })
        .returning();
      await insertNodeRun(tx, firstNodeRun);
      return toRun(row!);
    });
  }

  async getRun(runId: string): Promise<PipelineRunRecord | null> {
    const rows = await this.db
      .select()
      .from(pipelineRuns)
      .where(eq(pipelineRuns.runId, runId))
      .limit(1);
    return rows[0] ? toRun(rows[0]) : null;
  }

  async findRunByExternalKey(
    projectId: string,
    pipelineId: string,
    externalKey: string,
  ): Promise<PipelineRunRecord | null> {
    const rows = await this.db
      .select()
      .from(pipelineRuns)
      .where(
        and(
          eq(pipelineRuns.projectId, projectId),
          eq(pipelineRuns.pipelineId, pipelineId),
          eq(pipelineRuns.externalKey, externalKey),
        ),
      )
      .limit(1);
    return rows[0] ? toRun(rows[0]) : null;
  }

  async listRuns(filter?: ListPipelineRunsFilter): Promise<PipelineRunRecord[]> {
    const conditions = [];
    if (filter?.projectId) conditions.push(eq(pipelineRuns.projectId, filter.projectId));
    if (filter?.pipelineId) conditions.push(eq(pipelineRuns.pipelineId, filter.pipelineId));
    if (filter?.version !== undefined) {
      conditions.push(eq(pipelineRuns.pipelineVersion, filter.version));
    }
    if (filter?.nodeId) conditions.push(eq(pipelineRuns.currentNodeId, filter.nodeId));
    if (filter?.status) conditions.push(eq(pipelineRuns.status, filter.status));
    if (filter?.beforeId !== undefined && filter.beforeId > 0) {
      conditions.push(lt(pipelineRuns.id, Math.trunc(filter.beforeId)));
    }

    const rows = await this.db
      .select()
      .from(pipelineRuns)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(pipelineRuns.id))
      .limit(clampLimit(filter?.limit, 50, 201));
    return rows.map(toRun);
  }

  async countRunsByVersion(
    projectId: string,
    pipelineId: string,
  ): Promise<PipelineVersionRunCounts[]> {
    const rows = await this.db
      .select({
        version: pipelineRuns.pipelineVersion,
        total: count(),
        active: sql<number>`count(*) filter (where ${pipelineRuns.status} not in ('completed', 'cancelled'))`,
      })
      .from(pipelineRuns)
      .where(and(eq(pipelineRuns.projectId, projectId), eq(pipelineRuns.pipelineId, pipelineId)))
      .groupBy(pipelineRuns.pipelineVersion)
      .orderBy(desc(pipelineRuns.pipelineVersion));
    return rows.map((row) => ({
      version: row.version,
      activeRunCount: Number(row.active),
      totalRunCount: Number(row.total),
    }));
  }

  async updateRunWorkspace(runId: string, patch: PipelineRunWorkspacePatch): Promise<void> {
    await this.db
      .update(pipelineRuns)
      .set({
        ...(patch.workspacePath !== undefined ? { workspacePath: patch.workspacePath } : {}),
        ...(patch.branchName !== undefined ? { branchName: patch.branchName } : {}),
        ...(patch.workspaceStatus !== undefined ? { workspaceStatus: patch.workspaceStatus } : {}),
        updatedAt: new Date(),
      })
      .where(eq(pipelineRuns.runId, runId));
  }

  async commitTransition(write: PipelineTransitionWrite): Promise<PipelineTransitionResult> {
    return this.db.transaction(async (tx): Promise<PipelineTransitionResult> => {
      if (write.capacity) {
        const { projectId, pipelineId, nodeId, limit } = write.capacity;
        // Serializes capacity checks for one node across processes.
        const lockKey = `pipeline-node:${projectId}:${pipelineId}:${nodeId}`;
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);
        const [row] = await tx
          .select({ running: count() })
          .from(pipelineNodeRuns)
          .where(
            and(
              eq(pipelineNodeRuns.projectId, projectId),
              eq(pipelineNodeRuns.pipelineId, pipelineId),
              eq(pipelineNodeRuns.nodeId, nodeId),
              eq(pipelineNodeRuns.status, "running"),
            ),
          );
        if (Number(row?.running ?? 0) >= limit) return { status: "no_capacity" };
      }

      const patch = write.runPatch;
      const [runRow] = await tx
        .update(pipelineRuns)
        .set({
          ...(patch.currentNodeId !== undefined ? { currentNodeId: patch.currentNodeId } : {}),
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.loopCounts !== undefined ? { loopCounts: patch.loopCounts } : {}),
          ...(patch.clearStatusSummary
            ? { statusSummary: null }
            : patch.statusSummary !== undefined
              ? { statusSummary: patch.statusSummary }
              : {}),
          ...(patch.activeNodeRunId !== undefined
            ? { activeNodeRunId: patch.activeNodeRunId }
            : {}),
          ...(patch.latestNodeOutputs !== undefined
            ? { latestNodeOutputs: patch.latestNodeOutputs }
            : {}),
          ...(patch.finishedAt !== undefined ? { finishedAt: new Date(patch.finishedAt) } : {}),
          stateVersion: sql`${pipelineRuns.stateVersion} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(pipelineRuns.runId, write.runId),
            eq(pipelineRuns.stateVersion, write.expectedStateVersion),
          ),
        )
        .returning();
      // Nothing has been written yet, so returning commits an empty transaction.
      if (!runRow) return { status: "conflict" };

      let record: PipelineActionRecord | undefined;
      if (write.record) {
        const [latest] = await tx
          .select({ sequence: max(pipelineActionRecords.sequence) })
          .from(pipelineActionRecords)
          .where(eq(pipelineActionRecords.runId, write.runId));
        const [recordRow] = await tx
          .insert(pipelineActionRecords)
          .values({
            ...write.record,
            sequence: (latest?.sequence ?? 0) + 1,
            nodeRunId: write.record.nodeRunId ?? null,
            actorId: write.record.actorId ?? null,
            toNodeId: write.record.toNodeId ?? null,
            createdAt: new Date(write.record.createdAt),
          })
          .returning();
        record = toActionRecord(recordRow!);
      }

      if (write.nodeRunPatch) {
        await updateNodeRun(tx, write.nodeRunPatch.nodeRunId, write.nodeRunPatch.patch);
      }
      if (write.newNodeRun) await insertNodeRun(tx, write.newNodeRun);

      return { status: "committed", run: toRun(runRow), ...(record ? { record } : {}) };
    });
  }

  async getNodeRun(nodeRunId: string): Promise<PipelineNodeRunRecord | null> {
    const rows = await this.db
      .select()
      .from(pipelineNodeRuns)
      .where(eq(pipelineNodeRuns.nodeRunId, nodeRunId))
      .limit(1);
    return rows[0] ? toNodeRun(rows[0]) : null;
  }

  async findNodeRunBySession(sessionId: string): Promise<PipelineNodeRunRecord | null> {
    const rows = await this.db
      .select()
      .from(pipelineNodeRuns)
      .where(eq(pipelineNodeRuns.sessionId, sessionId))
      .limit(1);
    return rows[0] ? toNodeRun(rows[0]) : null;
  }

  async listNodeRuns(runId: string): Promise<PipelineNodeRunRecord[]> {
    const rows = await this.db
      .select()
      .from(pipelineNodeRuns)
      .where(eq(pipelineNodeRuns.runId, runId))
      .orderBy(asc(pipelineNodeRuns.sequence));
    return rows.map(toNodeRun);
  }

  async listNodeRunsByStatus(
    projectId: string,
    statuses: readonly PipelineNodeRunStatus[],
  ): Promise<PipelineNodeRunRecord[]> {
    if (statuses.length === 0) return [];
    const rows = await this.db
      .select()
      .from(pipelineNodeRuns)
      .where(
        and(
          eq(pipelineNodeRuns.projectId, projectId),
          inArray(pipelineNodeRuns.status, [...statuses]),
        ),
      )
      .orderBy(asc(pipelineNodeRuns.id));
    return rows.map(toNodeRun);
  }

  async listDueNodeRuns(projectId: string, asOf: Date): Promise<PipelineNodeRunRecord[]> {
    const rows = await this.db
      .select()
      .from(pipelineNodeRuns)
      .where(
        and(
          eq(pipelineNodeRuns.projectId, projectId),
          eq(pipelineNodeRuns.status, "waiting"),
          isNotNull(pipelineNodeRuns.nextPollAt),
          lte(pipelineNodeRuns.nextPollAt, asOf),
        ),
      )
      .orderBy(asc(pipelineNodeRuns.nextPollAt));
    return rows.map(toNodeRun);
  }

  async getNextPollAt(projectId: string): Promise<string | null> {
    const rows = await this.db
      .select({ nextPollAt: min(pipelineNodeRuns.nextPollAt) })
      .from(pipelineNodeRuns)
      .where(
        and(
          eq(pipelineNodeRuns.projectId, projectId),
          eq(pipelineNodeRuns.status, "waiting"),
          isNotNull(pipelineNodeRuns.nextPollAt),
        ),
      );
    return rows[0]?.nextPollAt?.toISOString() ?? null;
  }

  async updateNodeRunProgress(
    nodeRunId: string,
    patch: Pick<PipelineNodeRunPatch, "sessionId" | "agentTurnId" | "stepState">,
  ): Promise<void> {
    await updateNodeRun(this.db, nodeRunId, patch);
  }

  async listActionRecords(
    runId: string,
    filter?: ListPipelineActionsFilter,
  ): Promise<PipelineActionRecord[]> {
    const conditions = [eq(pipelineActionRecords.runId, runId)];
    if (filter?.afterSequence !== undefined) {
      conditions.push(gt(pipelineActionRecords.sequence, filter.afterSequence));
    }
    if (filter?.nodeId) conditions.push(eq(pipelineActionRecords.nodeId, filter.nodeId));
    if (filter?.action) conditions.push(eq(pipelineActionRecords.action, filter.action));

    const rows = await this.db
      .select()
      .from(pipelineActionRecords)
      .where(and(...conditions))
      .orderBy(asc(pipelineActionRecords.sequence))
      .limit(clampLimit(filter?.limit, 200, 1000));
    return rows.map(toActionRecord);
  }

  async getActionRecord(recordId: string): Promise<PipelineActionRecord | null> {
    const rows = await this.db
      .select()
      .from(pipelineActionRecords)
      .where(eq(pipelineActionRecords.recordId, recordId))
      .limit(1);
    return rows[0] ? toActionRecord(rows[0]) : null;
  }

  async getLatestActionSequence(runId: string): Promise<number> {
    const rows = await this.db
      .select({ latest: max(pipelineActionRecords.sequence) })
      .from(pipelineActionRecords)
      .where(eq(pipelineActionRecords.runId, runId));
    return rows[0]?.latest ?? 0;
  }

  async appendNodeLogs(logs: readonly PipelineNodeLogRecord[]): Promise<void> {
    if (logs.length === 0) return;
    await this.db.insert(pipelineNodeLogs).values(
      logs.map((entry) => ({
        nodeRunId: entry.nodeRunId,
        runId: entry.runId,
        projectId: entry.projectId,
        sequence: entry.sequence,
        level: entry.level,
        message: entry.message,
        fields: entry.fields ?? null,
        createdAt: new Date(entry.createdAt),
      })),
    );
  }

  async listNodeLogs(
    nodeRunId: string,
    filter?: ListPipelineNodeLogsFilter,
  ): Promise<PipelineNodeLogRecord[]> {
    const conditions = [eq(pipelineNodeLogs.nodeRunId, nodeRunId)];
    if (filter?.afterSequence !== undefined) {
      conditions.push(gt(pipelineNodeLogs.sequence, filter.afterSequence));
    }
    if (filter?.level) conditions.push(eq(pipelineNodeLogs.level, filter.level));

    const rows = await this.db
      .select()
      .from(pipelineNodeLogs)
      .where(and(...conditions))
      .orderBy(asc(pipelineNodeLogs.sequence))
      .limit(clampLimit(filter?.limit, 200, 1000));
    return rows.map(toNodeLog);
  }

  async getLatestNodeLogSequence(nodeRunId: string): Promise<number> {
    const rows = await this.db
      .select({ latest: max(pipelineNodeLogs.sequence) })
      .from(pipelineNodeLogs)
      .where(eq(pipelineNodeLogs.nodeRunId, nodeRunId));
    return rows[0]?.latest ?? 0;
  }
}

/** Inserts a node run with the next sequence of its run and the next attempt of its node. */
async function insertNodeRun(db: DrizzleExecutor, nodeRun: NewPipelineNodeRun): Promise<void> {
  const [latest] = await db
    .select({
      sequence: max(pipelineNodeRuns.sequence),
      attempt: sql<
        number | null
      >`max(${pipelineNodeRuns.attempt}) filter (where ${pipelineNodeRuns.nodeId} = ${nodeRun.nodeId})`,
    })
    .from(pipelineNodeRuns)
    .where(eq(pipelineNodeRuns.runId, nodeRun.runId));
  await db.insert(pipelineNodeRuns).values({
    nodeRunId: nodeRun.nodeRunId,
    runId: nodeRun.runId,
    projectId: nodeRun.projectId,
    pipelineId: nodeRun.pipelineId,
    nodeId: nodeRun.nodeId,
    attempt: Number(latest?.attempt ?? 0) + 1,
    sequence: (latest?.sequence ?? 0) + 1,
    executorType: nodeRun.executorType,
    sessionId: nodeRun.sessionId ?? null,
    triggeredByRecordId: nodeRun.triggeredByRecordId ?? null,
    traceparent: nodeRun.traceparent ?? null,
    status: nodeRun.status,
    inputContext: nodeRun.inputContext,
    finalAction: nodeRun.finalAction ?? null,
    outputSummary: nodeRun.outputSummary ?? null,
    errorMessage: nodeRun.errorMessage ?? null,
    stepState: nodeRun.stepState,
    nextPollAt: nodeRun.nextPollAt ? new Date(nodeRun.nextPollAt) : null,
    pollCount: nodeRun.pollCount,
    agentTurnId: nodeRun.agentTurnId ?? null,
    reminderSent: nodeRun.reminderSent,
    pendingDecision: nodeRun.pendingDecision ?? null,
    startedAt: nodeRun.startedAt ? new Date(nodeRun.startedAt) : null,
    finishedAt: nodeRun.finishedAt ? new Date(nodeRun.finishedAt) : null,
    durationMs: nodeRun.durationMs ?? null,
    createdAt: new Date(nodeRun.createdAt),
    updatedAt: new Date(nodeRun.updatedAt),
  });
}

async function updateNodeRun(
  db: DrizzleExecutor,
  nodeRunId: string,
  patch: PipelineNodeRunPatch,
): Promise<void> {
  await db
    .update(pipelineNodeRuns)
    .set({
      ...(patch.sessionId !== undefined ? { sessionId: patch.sessionId } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.finalAction !== undefined ? { finalAction: patch.finalAction } : {}),
      ...(patch.outputSummary !== undefined ? { outputSummary: patch.outputSummary } : {}),
      ...(patch.errorMessage !== undefined ? { errorMessage: patch.errorMessage } : {}),
      ...(patch.stepState !== undefined ? { stepState: patch.stepState } : {}),
      ...(patch.clearNextPollAt
        ? { nextPollAt: null }
        : patch.nextPollAt !== undefined
          ? { nextPollAt: new Date(patch.nextPollAt) }
          : {}),
      ...(patch.pollCount !== undefined ? { pollCount: patch.pollCount } : {}),
      ...(patch.agentTurnId !== undefined ? { agentTurnId: patch.agentTurnId } : {}),
      ...(patch.reminderSent !== undefined ? { reminderSent: patch.reminderSent } : {}),
      ...(patch.clearPendingDecision
        ? { pendingDecision: null }
        : patch.pendingDecision !== undefined
          ? { pendingDecision: patch.pendingDecision }
          : {}),
      ...(patch.startedAt !== undefined ? { startedAt: new Date(patch.startedAt) } : {}),
      ...(patch.finishedAt !== undefined ? { finishedAt: new Date(patch.finishedAt) } : {}),
      ...(patch.durationMs !== undefined ? { durationMs: patch.durationMs } : {}),
      updatedAt: new Date(),
    })
    .where(eq(pipelineNodeRuns.nodeRunId, nodeRunId));
}

function toRevision(row: PipelineRevisionRow): PipelineRevisionRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    pipelineId: row.pipelineId,
    version: row.version,
    topologyHash: row.topologyHash,
    nodesSnapshot: row.nodesSnapshot ?? [],
    createdAt: row.createdAt.toISOString(),
  };
}

function toRun(row: PipelineRunRow): PipelineRunRecord {
  return {
    id: row.id,
    runId: row.runId,
    projectId: row.projectId,
    pipelineId: row.pipelineId,
    pipelineVersion: row.pipelineVersion,
    ...(row.externalKey !== null ? { externalKey: row.externalKey } : {}),
    ...(row.externalUrl !== null ? { externalUrl: row.externalUrl } : {}),
    title: row.title,
    ...(row.description !== null ? { description: row.description } : {}),
    data: row.data ?? {},
    metadata: row.metadata ?? {},
    currentNodeId: row.currentNodeId,
    status: row.status,
    ...(row.workspacePath !== null ? { workspacePath: row.workspacePath } : {}),
    ...(row.branchName !== null ? { branchName: row.branchName } : {}),
    workspaceStatus: row.workspaceStatus,
    loopCounts: row.loopCounts ?? {},
    ...(row.statusSummary !== null ? { statusSummary: row.statusSummary } : {}),
    ...(row.activeNodeRunId !== null ? { activeNodeRunId: row.activeNodeRunId } : {}),
    latestNodeOutputs: row.latestNodeOutputs ?? {},
    createdBy: row.createdBy,
    stateVersion: row.stateVersion,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(row.finishedAt !== null ? { finishedAt: row.finishedAt.toISOString() } : {}),
  };
}

function toNodeRun(row: PipelineNodeRunRow): PipelineNodeRunRecord {
  return {
    id: row.id,
    nodeRunId: row.nodeRunId,
    runId: row.runId,
    projectId: row.projectId,
    pipelineId: row.pipelineId,
    nodeId: row.nodeId,
    attempt: row.attempt,
    sequence: row.sequence,
    executorType: row.executorType,
    ...(row.sessionId !== null ? { sessionId: row.sessionId } : {}),
    ...(row.triggeredByRecordId !== null ? { triggeredByRecordId: row.triggeredByRecordId } : {}),
    ...(row.traceparent !== null ? { traceparent: row.traceparent } : {}),
    status: row.status,
    inputContext: row.inputContext ?? {},
    ...(row.finalAction !== null ? { finalAction: row.finalAction } : {}),
    ...(row.outputSummary !== null ? { outputSummary: row.outputSummary } : {}),
    ...(row.errorMessage !== null ? { errorMessage: row.errorMessage } : {}),
    stepState: row.stepState ?? {},
    ...(row.nextPollAt !== null ? { nextPollAt: row.nextPollAt.toISOString() } : {}),
    pollCount: row.pollCount,
    ...(row.agentTurnId !== null ? { agentTurnId: row.agentTurnId } : {}),
    reminderSent: row.reminderSent,
    ...(row.pendingDecision !== null ? { pendingDecision: row.pendingDecision } : {}),
    ...(row.startedAt !== null ? { startedAt: row.startedAt.toISOString() } : {}),
    ...(row.finishedAt !== null ? { finishedAt: row.finishedAt.toISOString() } : {}),
    ...(row.durationMs !== null ? { durationMs: row.durationMs } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toActionRecord(row: PipelineActionRecordRow): PipelineActionRecord {
  return {
    id: row.id,
    recordId: row.recordId,
    runId: row.runId,
    projectId: row.projectId,
    sequence: row.sequence,
    ...(row.nodeRunId !== null ? { nodeRunId: row.nodeRunId } : {}),
    nodeId: row.nodeId,
    attempt: row.attempt,
    action: row.action,
    actorType: row.actorType,
    ...(row.actorId !== null ? { actorId: row.actorId } : {}),
    fromNodeId: row.fromNodeId,
    ...(row.toNodeId !== null ? { toNodeId: row.toNodeId } : {}),
    fromStatus: row.fromStatus,
    toStatus: row.toStatus,
    context: row.context ?? {},
    result: row.result ?? {},
    createdAt: row.createdAt.toISOString(),
  };
}

function toNodeLog(row: PipelineNodeLogRow): PipelineNodeLogRecord {
  return {
    id: row.id,
    nodeRunId: row.nodeRunId,
    runId: row.runId,
    projectId: row.projectId,
    sequence: row.sequence,
    level: row.level,
    message: row.message,
    ...(row.fields !== null ? { fields: row.fields } : {}),
    createdAt: row.createdAt.toISOString(),
  };
}
