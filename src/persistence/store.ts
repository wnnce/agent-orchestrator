import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  ScheduledJobStatus,
  type ActionExecutionFilter,
  type ActionExecutionRecord,
  type ArtifactRecord,
  type EventRecord,
  type InboundMessageRecord,
  type NotificationDelivery,
  type ScheduledJobRecord,
  type ScheduledJobStatusCode,
  type SessionRoute,
  type TaskExecutionRecord,
  type TurnRecord,
} from "../domain/types.ts";

export interface Store {
  createSession(route: SessionRoute): Promise<SessionRoute>;
  getSession(sessionId: string): Promise<SessionRoute | null>;
  listSessions(
    projectId?: string,
    options?: { includeTasks?: boolean },
  ): Promise<SessionRoute[]>;
  /** Saves session state. Titles are not written here; see updateSessionTitle and setTitleIfEmpty. */
  updateSession(route: SessionRoute): Promise<void>;
  updateSessionTitle(sessionId: string, title: string): Promise<boolean>;
  /** Sets the title only while the session has none; returns whether it was set. */
  setTitleIfEmpty(sessionId: string, title: string): Promise<boolean>;
  findSessionByExternal(
    channel: string,
    conversationId: string,
    threadId?: string,
  ): Promise<SessionRoute | null>;
  claimInboundMessage(message: InboundMessageRecord): Promise<boolean>;
  releaseInboundMessage(messageId: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  createTurn(turn: TurnRecord): Promise<void>;
  getTurn(turnId: string): Promise<TurnRecord | null>;
  getLatestTurn(sessionId: string): Promise<TurnRecord | null>;
  updateTurn(
    turnId: string,
    patch: Partial<
      Pick<
        TurnRecord,
        | "status"
        | "runtimeTurnId"
        | "output"
        | "error"
        | "startedAt"
        | "finishedAt"
      >
    >,
  ): Promise<void>;
  appendEvent(event: EventRecord): Promise<EventRecord>;
  getLatestEventSequence(sessionId: string): Promise<number>;
  listEvents(sessionId: string, afterSequence?: number): Promise<EventRecord[]>;
  addArtifact(artifact: ArtifactRecord): Promise<void>;
  listArtifacts(sessionId: string): Promise<ArtifactRecord[]>;
  recordNotificationDelivery(delivery: NotificationDelivery): Promise<void>;
  listNotificationDeliveries(filter?: {
    projectId?: string | undefined;
    sessionId?: string | undefined;
    status?: "sent" | "partial" | "failed" | undefined;
    limit?: number | undefined;
  }): Promise<NotificationDelivery[]>;
  pendingNotifications?(
    limit?: number,
    projectId?: string,
  ): Promise<NotificationDelivery[]>;
  recordTaskExecution(execution: TaskExecutionRecord): Promise<void>;
  getLatestTaskExecutionState(
    taskKey: string,
  ): Promise<Record<string, unknown> | null>;
  listTaskExecutions(
    taskKey?: string | undefined,
    limit?: number | undefined,
    projectId?: string | undefined,
  ): Promise<TaskExecutionRecord[]>;
  createScheduledJob(job: ScheduledJobRecord): Promise<void>;
  cancelScheduledJob(sessionId: string, identifier: string): Promise<boolean>;
  cancelScheduledJobById(jobId: string): Promise<boolean>;
  listDueScheduledJobs(
    projectId?: string,
    asOf?: Date,
  ): Promise<ScheduledJobRecord[]>;
  listScheduledJobs(filter?: {
    sessionId?: string | undefined;
    projectId?: string | undefined;
    status?: ScheduledJobStatusCode | undefined;
    limit?: number | undefined;
  }): Promise<ScheduledJobRecord[]>;
  updateScheduledJobStatus(
    jobId: string,
    status: ScheduledJobStatusCode,
    summary?: string,
    finishedAt?: string,
  ): Promise<void>;
  recordActionExecution(record: ActionExecutionRecord): Promise<void>;
  listActionExecutions(
    filter?: ActionExecutionFilter,
  ): Promise<ActionExecutionRecord[]>;
  close(): Promise<void>;
}

export class MemoryStore implements Store {
  readonly sessions = new Map<string, SessionRoute>();
  readonly turns = new Map<string, TurnRecord>();
  readonly events = new Map<string, EventRecord[]>();
  readonly artifacts: ArtifactRecord[] = [];
  readonly notifications = new Map<string, NotificationDelivery>();
  readonly inboundMessages = new Map<string, string | undefined>();
  readonly taskExecutions: TaskExecutionRecord[] = [];
  readonly scheduledJobs = new Map<string, ScheduledJobRecord>();
  readonly actionExecutions: ActionExecutionRecord[] = [];
  async createSession(route: SessionRoute): Promise<SessionRoute> {
    const sessionWithSource: SessionRoute = {
      ...route,
      source: route.source ?? "unknown",
      runtime:
        route.runtime ??
        (route.metadata?.runtime as string | undefined) ??
        "unknown",
    };
    this.sessions.set(route.sessionId, sessionWithSource);
    return sessionWithSource;
  }
  async getSession(sessionId: string): Promise<SessionRoute | null> {
    return this.sessions.get(sessionId) ?? null;
  }
  async listSessions(
    projectId?: string,
    options?: { includeTasks?: boolean },
  ): Promise<SessionRoute[]> {
    let all = Array.from(this.sessions.values());
    if (projectId) {
      all = all.filter((s) => s.projectId === projectId);
    }
    if (!options?.includeTasks) {
      all = all.filter((s) => s.source !== "task");
    }
    return all.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  }
  async updateSession(route: SessionRoute): Promise<void> {
    const { title: _ignored, ...state } = route;
    const title = this.sessions.get(route.sessionId)?.title;
    this.sessions.set(route.sessionId, { ...state, ...(title ? { title } : {}) });
  }
  async updateSessionTitle(sessionId: string, title: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.title = title;
    return true;
  }
  async setTitleIfEmpty(sessionId: string, title: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session || session.title) return false;
    session.title = title;
    return true;
  }
  async findSessionByExternal(
    channel: string,
    conversationId: string,
    threadId?: string,
  ): Promise<SessionRoute | null> {
    const matches = [...this.sessions.values()].filter(
      (session) =>
        session.externalChannel === channel &&
        session.externalConversationId === conversationId &&
        (session.externalThreadId ?? undefined) === (threadId ?? undefined) &&
        session.status !== "archived",
    );
    matches.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
    return matches[0] ?? null;
  }
  async claimInboundMessage(message: InboundMessageRecord): Promise<boolean> {
    if (this.inboundMessages.has(message.messageId)) return false;
    this.inboundMessages.set(message.messageId, message.sessionId);
    return true;
  }
  async releaseInboundMessage(messageId: string): Promise<void> {
    this.inboundMessages.delete(messageId);
  }
  async deleteSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    this.events.delete(sessionId);
    for (const [turnId, turn] of this.turns) {
      if (turn.sessionId === sessionId) {
        this.turns.delete(turnId);
      }
    }
    for (let i = this.artifacts.length - 1; i >= 0; i--) {
      const artifact = this.artifacts[i];
      if (artifact?.sessionId === sessionId) {
        this.artifacts.splice(i, 1);
      }
    }
    for (const [messageId, inboundSessionId] of this.inboundMessages) {
      if (inboundSessionId === sessionId)
        this.inboundMessages.delete(messageId);
    }
  }
  async createTurn(turn: TurnRecord): Promise<void> {
    this.turns.set(turn.id, turn);
  }
  async getTurn(turnId: string): Promise<TurnRecord | null> {
    return this.turns.get(turnId) ?? null;
  }
  async getLatestTurn(sessionId: string): Promise<TurnRecord | null> {
    const list = Array.from(this.turns.values()).filter(
      (t) => t.sessionId === sessionId,
    );
    return list.at(-1) ?? null;
  }
  async updateTurn(turnId: string, patch: Partial<TurnRecord>): Promise<void> {
    const current = this.turns.get(turnId);
    if (!current) throw new Error(`turn not found: ${turnId}`);
    this.turns.set(turnId, { ...current, ...patch });
  }
  async appendEvent(event: EventRecord): Promise<EventRecord> {
    const list = this.events.get(event.sessionId) ?? [];
    list.push(event);
    this.events.set(event.sessionId, list);
    return event;
  }
  async getLatestEventSequence(sessionId: string): Promise<number> {
    const list = this.events.get(sessionId);
    return list?.at(-1)?.sequence ?? 0;
  }
  async listEvents(
    sessionId: string,
    afterSequence = 0,
  ): Promise<EventRecord[]> {
    return (this.events.get(sessionId) ?? []).filter(
      (event) => event.sequence > afterSequence,
    );
  }
  async addArtifact(artifact: ArtifactRecord): Promise<void> {
    this.artifacts.push(artifact);
  }
  async listArtifacts(sessionId: string): Promise<ArtifactRecord[]> {
    return this.artifacts.filter((item) => item.sessionId === sessionId);
  }
  async recordNotificationDelivery(
    delivery: NotificationDelivery,
  ): Promise<void> {
    this.notifications.set(delivery.id, delivery);
  }
  async listNotificationDeliveries(filter?: {
    projectId?: string | undefined;
    sessionId?: string | undefined;
    status?: "sent" | "partial" | "failed" | undefined;
    limit?: number | undefined;
  }): Promise<NotificationDelivery[]> {
    let items = [...this.notifications.values()];
    if (filter?.projectId)
      items = items.filter((d) => d.projectId === filter.projectId);
    if (filter?.sessionId)
      items = items.filter((d) => d.sessionId === filter.sessionId);
    if (filter?.status) items = items.filter((d) => d.status === filter.status);
    return items.slice(0, filter?.limit ?? 50);
  }
  async pendingNotifications(
    _limit = 20,
    _projectId?: string,
  ): Promise<NotificationDelivery[]> {
    return [];
  }
  async recordTaskExecution(execution: TaskExecutionRecord): Promise<void> {
    this.taskExecutions.unshift(execution);
  }
  async getLatestTaskExecutionState(
    taskKey: string,
  ): Promise<Record<string, unknown> | null> {
    const found = this.taskExecutions.find(
      (item) =>
        item.taskKey === taskKey &&
        item.status === "success" &&
        item.stateAfter,
    );
    return found?.stateAfter ?? null;
  }
  async listTaskExecutions(
    taskKey?: string | undefined,
    limit = 20,
    projectId?: string | undefined,
  ): Promise<TaskExecutionRecord[]> {
    let list = this.taskExecutions;
    if (taskKey) list = list.filter((item) => item.taskKey === taskKey);
    if (projectId) list = list.filter((item) => item.projectId === projectId);
    return list.slice(0, limit);
  }
  async createScheduledJob(job: ScheduledJobRecord): Promise<void> {
    this.scheduledJobs.set(job.jobId, job);
  }
  async cancelScheduledJob(
    sessionId: string,
    identifier: string,
  ): Promise<boolean> {
    for (const [id, job] of this.scheduledJobs.entries()) {
      if (
        job.sessionId === sessionId &&
        job.status === ScheduledJobStatus.PENDING &&
        (job.jobId === identifier || job.name === identifier)
      ) {
        this.scheduledJobs.set(id, {
          ...job,
          status: ScheduledJobStatus.CANCELLED,
          updatedAt: new Date().toISOString(),
        });
        return true;
      }
    }
    return false;
  }
  async cancelScheduledJobById(jobId: string): Promise<boolean> {
    for (const [id, job] of this.scheduledJobs.entries()) {
      if (
        (job.jobId === jobId || String(job.id) === jobId) &&
        job.status === ScheduledJobStatus.PENDING
      ) {
        this.scheduledJobs.set(id, {
          ...job,
          status: ScheduledJobStatus.CANCELLED,
          updatedAt: new Date().toISOString(),
        });
        return true;
      }
    }
    return false;
  }
  async listScheduledJobs(filter?: {
    sessionId?: string | undefined;
    projectId?: string | undefined;
    status?: ScheduledJobStatusCode | undefined;
    limit?: number | undefined;
  }): Promise<ScheduledJobRecord[]> {
    let list = [...this.scheduledJobs.values()].filter(
      (item) => (item.deletedAt ?? 0) === 0,
    );
    if (filter?.sessionId) {
      list = list.filter((item) => item.sessionId === filter.sessionId);
    }
    if (filter?.projectId) {
      list = list.filter((item) => item.projectId === filter.projectId);
    }
    if (filter?.status !== undefined) {
      list = list.filter((item) => item.status === filter.status);
    }
    list.sort((a, b) => (b.id ?? 0) - (a.id ?? 0));
    return list.slice(0, filter?.limit ?? 50);
  }
  async listDueScheduledJobs(
    projectId?: string,
    asOf: Date = new Date(),
  ): Promise<ScheduledJobRecord[]> {
    const threshold = asOf.toISOString();
    return [...this.scheduledJobs.values()]
      .filter(
        (item) =>
          item.status === ScheduledJobStatus.PENDING &&
          item.triggerAt <= threshold &&
          (!projectId || item.projectId === projectId),
      )
      .sort((a, b) => a.triggerAt.localeCompare(b.triggerAt));
  }
  async updateScheduledJobStatus(
    jobId: string,
    status: ScheduledJobStatusCode,
    summary?: string,
    finishedAt?: string,
  ): Promise<void> {
    const current = this.scheduledJobs.get(jobId);
    if (current) {
      this.scheduledJobs.set(jobId, {
        ...current,
        status,
        ...(summary !== undefined ? { resultSummary: summary } : {}),
        ...(finishedAt !== undefined ? { finishedAt } : {}),
        updatedAt: new Date().toISOString(),
      });
    }
  }
  async recordActionExecution(record: ActionExecutionRecord): Promise<void> {
    this.actionExecutions.unshift({
      ...record,
      createdAt: record.createdAt ?? new Date().toISOString(),
    });
  }
  async listActionExecutions(
    filter?: ActionExecutionFilter,
  ): Promise<ActionExecutionRecord[]> {
    let list = this.actionExecutions;
    if (filter?.projectId)
      list = list.filter((item) => item.projectId === filter.projectId);
    if (filter?.sessionId)
      list = list.filter((item) => item.sessionId === filter.sessionId);
    if (filter?.actionName)
      list = list.filter((item) => item.actionName === filter.actionName);
    return list.slice(0, filter?.limit ?? 50);
  }
  async close(): Promise<void> {}
}

export class PostgresStore implements Store {
  constructor(private readonly pool: Pool) {}
  static fromUrl(databaseUrl: string): PostgresStore {
    return new PostgresStore(
      new Pool({ connectionString: databaseUrl, max: 10 }),
    );
  }
  async createSession(route: SessionRoute): Promise<SessionRoute> {
    const title = route.title ?? null;
    const source = route.source ?? "unknown";
    const runtime =
      route.runtime ??
      (route.metadata?.runtime as string | undefined) ??
      "unknown";
    const metadata = { ...(route.metadata ?? {}), runtime };
    const metadataJson = JSON.stringify(metadata);
    await this.pool.query(
      "INSERT INTO sessions(session_id, project_id, project_runtime_id, runtime_session_id, config_revision, status, source, runtime, external_channel, external_conversation_id, external_thread_id, last_active_at, created_at, updated_at, deleted_at, title, metadata, workspace_path) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now(),now(),0,$13,$14::jsonb,$15)",
      [
        route.sessionId,
        route.projectId,
        route.projectRuntimeId,
        route.runtimeSessionId,
        route.configRevision,
        route.status,
        source,
        runtime,
        route.externalChannel ?? null,
        route.externalConversationId ?? null,
        route.externalThreadId ?? null,
        route.lastActiveAt,
        title,
        metadataJson,
        route.workspacePath ?? null,
      ],
    );
    return { ...route, source, runtime, metadata };
  }
  async getSession(sessionId: string): Promise<SessionRoute | null> {
    const result = await this.pool.query(
      "SELECT * FROM sessions WHERE session_id = $1 AND deleted_at = 0",
      [sessionId],
    );
    return result.rows[0] ? toSessionRoute(result.rows[0]) : null;
  }

  async listSessions(
    projectId?: string,
    options?: { includeTasks?: boolean },
  ): Promise<SessionRoute[]> {
    const wheres = ["deleted_at = 0"];
    const params: unknown[] = [];
    if (projectId) {
      params.push(projectId);
      wheres.push(`project_id = $${params.length}`);
    }
    if (!options?.includeTasks) {
      wheres.push("source != 'task'");
    }
    const query = `SELECT * FROM sessions WHERE ${wheres.join(" AND ")} ORDER BY last_active_at DESC`;
    const result = await this.pool.query(query, params);
    return result.rows.map(toSessionRoute);
  }
  async updateSession(route: SessionRoute): Promise<void> {
    const metadata = {
      ...(route.metadata ?? {}),
      ...(route.runtime ? { runtime: route.runtime } : {}),
    };
    const metadataJson = JSON.stringify(metadata);
    await this.pool.query(
      "UPDATE sessions SET project_id=$2, project_runtime_id=$3, runtime_session_id=$4, config_revision=$5, status=$6, last_active_at=$7, metadata=$8::jsonb, source=COALESCE($9, source), runtime=COALESCE($10, runtime), updated_at=now() WHERE session_id=$1 AND deleted_at = 0",
      [
        route.sessionId,
        route.projectId,
        route.projectRuntimeId,
        route.runtimeSessionId,
        route.configRevision,
        route.status,
        route.lastActiveAt,
        metadataJson,
        route.source ?? null,
        route.runtime ?? null,
      ],
    );
  }
  async updateSessionTitle(sessionId: string, title: string): Promise<boolean> {
    const result = await this.pool.query(
      "UPDATE sessions SET title=$2, updated_at=now() WHERE session_id=$1 AND deleted_at = 0",
      [sessionId, title],
    );
    return (result.rowCount ?? 0) > 0;
  }
  async setTitleIfEmpty(sessionId: string, title: string): Promise<boolean> {
    const result = await this.pool.query(
      "UPDATE sessions SET title=$2, updated_at=now() WHERE session_id=$1 AND title IS NULL AND deleted_at = 0",
      [sessionId, title],
    );
    return (result.rowCount ?? 0) > 0;
  }
  async findSessionByExternal(
    channel: string,
    conversationId: string,
    threadId?: string,
  ): Promise<SessionRoute | null> {
    const result = await this.pool.query(
      "SELECT * FROM sessions WHERE external_channel=$1 AND external_conversation_id=$2 AND external_thread_id IS NOT DISTINCT FROM $3 AND status != 'archived' AND deleted_at = 0 ORDER BY last_active_at DESC LIMIT 1",
      [channel, conversationId, threadId ?? null],
    );
    return result.rows[0] ? toSessionRoute(result.rows[0]) : null;
  }
  async claimInboundMessage(message: InboundMessageRecord): Promise<boolean> {
    const result = await this.pool.query(
      "INSERT INTO inbound_messages(message_id,channel,conversation_id,thread_id,session_id,received_at,created_at) VALUES($1,$2,$3,$4,$5,$6,now()) ON CONFLICT(message_id) DO NOTHING",
      [
        message.messageId,
        message.channel,
        message.conversationId,
        message.threadId ?? null,
        message.sessionId ?? null,
        message.receivedAt,
      ],
    );
    return result.rowCount === 1;
  }
  async releaseInboundMessage(messageId: string): Promise<void> {
    await this.pool.query(
      "DELETE FROM inbound_messages WHERE message_id = $1",
      [messageId],
    );
  }
  async deleteSession(sessionId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const nowTs = Date.now();
      await client.query(
        "UPDATE scheduled_jobs SET deleted_at = $2, updated_at = now() WHERE session_id = $1 AND deleted_at = 0",
        [sessionId, nowTs],
      );
      await client.query(
        "UPDATE sessions SET deleted_at = $2, updated_at = now() WHERE session_id = $1 AND deleted_at = 0",
        [sessionId, nowTs],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
  async createTurn(turn: TurnRecord): Promise<void> {
    await this.pool.query(
      "INSERT INTO turns(turn_id,session_id,input,status,runtime_turn_id,output,error,created_at,started_at,finished_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [
        turn.id,
        turn.sessionId,
        turn.input,
        turn.status,
        turn.runtimeTurnId ?? null,
        turn.output ?? null,
        turn.error ?? null,
        turn.createdAt,
        turn.startedAt ?? null,
        turn.finishedAt ?? null,
      ],
    );
  }
  async getTurn(turnId: string): Promise<TurnRecord | null> {
    const result = await this.pool.query(
      "SELECT * FROM turns WHERE turn_id = $1",
      [turnId],
    );
    const row = result.rows[0];
    return row ? this.rowToTurn(row) : null;
  }
  async getLatestTurn(sessionId: string): Promise<TurnRecord | null> {
    const result = await this.pool.query(
      "SELECT * FROM turns WHERE session_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1",
      [sessionId],
    );
    const row = result.rows[0];
    return row ? this.rowToTurn(row) : null;
  }
  async updateTurn(
    turnId: string,
    patch: Partial<
      Pick<
        TurnRecord,
        | "status"
        | "runtimeTurnId"
        | "output"
        | "error"
        | "startedAt"
        | "finishedAt"
      >
    >,
  ): Promise<void> {
    const current = await this.getTurn(turnId);
    if (!current) throw new Error(`turn not found: ${turnId}`);
    const next = { ...current, ...patch };
    await this.pool.query(
      "UPDATE turns SET status=$2,runtime_turn_id=$3,output=$4,error=$5,started_at=$6,finished_at=$7 WHERE turn_id = $1",
      [
        turnId,
        next.status,
        next.runtimeTurnId ?? null,
        next.output ?? null,
        next.error ?? null,
        next.startedAt ?? null,
        next.finishedAt ?? null,
      ],
    );
  }
  async appendEvent(event: EventRecord): Promise<EventRecord> {
    await this.pool.query(
      "INSERT INTO events(event_id,project_id,session_id,turn_id,sequence,type,runtime,payload,schema_version,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)",
      [
        event.id,
        event.projectId,
        event.sessionId,
        event.turnId ?? null,
        event.sequence,
        event.type,
        event.runtime,
        JSON.stringify(event.payload),
        event.schemaVersion,
        event.createdAt,
      ],
    );
    return event;
  }
  async getLatestEventSequence(sessionId: string): Promise<number> {
    const result = await this.pool.query(
      "SELECT COALESCE(MAX(sequence), 0) AS max_seq FROM events WHERE session_id = $1",
      [sessionId],
    );
    return Number(result.rows[0]?.max_seq ?? 0);
  }
  async listEvents(
    sessionId: string,
    afterSequence = 0,
  ): Promise<EventRecord[]> {
    const result = await this.pool.query(
      "SELECT * FROM events WHERE session_id = $1 AND sequence > $2 ORDER BY sequence",
      [sessionId, afterSequence],
    );
    return result.rows.map((row) => ({
      id: row.event_id ?? row.id,
      projectId: row.project_id,
      sessionId: row.session_id,
      turnId: row.turn_id ?? undefined,
      sequence: row.sequence,
      type: row.type,
      runtime: row.runtime,
      payload: row.payload,
      createdAt: row.created_at.toISOString(),
      schemaVersion: row.schema_version,
    }));
  }
  async addArtifact(artifact: ArtifactRecord): Promise<void> {
    await this.pool.query(
      "INSERT INTO artifacts(artifact_id,project_id,session_id,turn_id,kind,path,content_type,size_bytes,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        artifact.id,
        artifact.projectId,
        artifact.sessionId,
        artifact.turnId ?? null,
        artifact.kind,
        artifact.path,
        artifact.contentType,
        artifact.sizeBytes,
        artifact.createdAt,
      ],
    );
  }
  async listArtifacts(sessionId: string): Promise<ArtifactRecord[]> {
    const result = await this.pool.query(
      "SELECT * FROM artifacts WHERE session_id = $1 ORDER BY created_at",
      [sessionId],
    );
    return result.rows.map((row) => ({
      id: row.artifact_id ?? row.id,
      projectId: row.project_id,
      sessionId: row.session_id,
      turnId: row.turn_id ?? undefined,
      kind: row.kind,
      path: row.path,
      contentType: row.content_type,
      sizeBytes: Number(row.size_bytes),
      createdAt: row.created_at.toISOString(),
    }));
  }
  async recordNotificationDelivery(
    delivery: NotificationDelivery,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO notification_deliveries(
        delivery_id, project_id, session_id, configs, message,
        status, details, created_at
      ) VALUES($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7::jsonb, $8)
      ON CONFLICT (delivery_id) DO UPDATE SET
        status = EXCLUDED.status,
        details = EXCLUDED.details`,
      [
        delivery.id,
        delivery.projectId,
        delivery.sessionId ?? null,
        JSON.stringify(delivery.configs),
        JSON.stringify(delivery.message),
        delivery.status,
        JSON.stringify(delivery.details ?? []),
        delivery.createdAt,
      ],
    );
  }
  async listNotificationDeliveries(filter?: {
    projectId?: string | undefined;
    sessionId?: string | undefined;
    status?: "sent" | "partial" | "failed" | undefined;
    limit?: number | undefined;
  }): Promise<NotificationDelivery[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (filter?.projectId) {
      conditions.push(`project_id = $${idx++}`);
      params.push(filter.projectId);
    }
    if (filter?.sessionId) {
      conditions.push(`session_id = $${idx++}`);
      params.push(filter.sessionId);
    }
    if (filter?.status) {
      conditions.push(`status = $${idx++}`);
      params.push(filter.status);
    }
    params.push(filter?.limit ?? 50);

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await this.pool.query(
      `SELECT * FROM notification_deliveries ${where} ORDER BY created_at DESC LIMIT $${idx}`,
      params,
    );

    return result.rows.map((row) => ({
      id: row.delivery_id ?? row.id,
      projectId: row.project_id,
      sessionId: row.session_id ?? undefined,
      configs: row.configs,
      message: row.message,
      status: row.status,
      details: row.details ?? [],
      createdAt: row.created_at.toISOString(),
    }));
  }
  async pendingNotifications(
    _limit = 20,
    _projectId?: string,
  ): Promise<NotificationDelivery[]> {
    return [];
  }
  async recordTaskExecution(execution: TaskExecutionRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO task_executions(
        execution_id, task_key, project_id, task_id, task_type,
        session_id, turn_id, status, started_at, finished_at,
        duration_ms, state_before, state_after, actions_summary, error_message, created_at
      ) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14::jsonb, $15, $16)`,
      [
        execution.executionId,
        execution.taskKey,
        execution.projectId,
        execution.taskId,
        execution.taskType,
        execution.sessionId ?? null,
        execution.turnId ?? null,
        execution.status,
        execution.startedAt ? new Date(execution.startedAt) : new Date(),
        execution.finishedAt ? new Date(execution.finishedAt) : null,
        execution.durationMs ?? null,
        execution.stateBefore ? JSON.stringify(execution.stateBefore) : null,
        execution.stateAfter ? JSON.stringify(execution.stateAfter) : null,
        execution.actionsSummary
          ? JSON.stringify(execution.actionsSummary)
          : "{}",
        execution.errorMessage ?? null,
        execution.createdAt ? new Date(execution.createdAt) : new Date(),
      ],
    );
  }

  async getLatestTaskExecutionState(
    taskKey: string,
  ): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      "SELECT state_after FROM task_executions WHERE task_key = $1 AND status = 'success' AND state_after IS NOT NULL ORDER BY id DESC LIMIT 1",
      [taskKey],
    );
    return (result.rows[0]?.state_after ?? null) as Record<
      string,
      unknown
    > | null;
  }

  async listTaskExecutions(
    taskKey?: string | undefined,
    limit = 20,
    projectId?: string | undefined,
  ): Promise<TaskExecutionRecord[]> {
    const params: unknown[] = [];
    const wheres: string[] = [];
    if (taskKey) {
      params.push(taskKey);
      wheres.push(`task_key = $${params.length}`);
    }
    if (projectId) {
      params.push(projectId);
      wheres.push(`project_id = $${params.length}`);
    }
    params.push(limit);
    const whereClause =
      wheres.length > 0 ? `WHERE ${wheres.join(" AND ")}` : "";
    const result = await this.pool.query(
      `SELECT * FROM task_executions ${whereClause} ORDER BY id DESC LIMIT $${params.length}`,
      params,
    );
    return result.rows.map((row) => ({
      id: Number(row.id),
      executionId: row.execution_id,
      taskKey: row.task_key,
      projectId: row.project_id,
      taskId: row.task_id,
      taskType: row.task_type,
      sessionId: row.session_id ?? undefined,
      turnId: row.turn_id ?? undefined,
      status: row.status,
      startedAt: row.started_at?.toISOString(),
      finishedAt: row.finished_at?.toISOString(),
      durationMs: row.duration_ms ? Number(row.duration_ms) : undefined,
      stateBefore: row.state_before ?? undefined,
      stateAfter: row.state_after ?? undefined,
      actionsSummary: row.actions_summary ?? undefined,
      errorMessage: row.error_message ?? undefined,
      createdAt: row.created_at?.toISOString(),
    }));
  }

  async createScheduledJob(job: ScheduledJobRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO scheduled_jobs(
        job_id, project_id, session_id, name, created_at, delay_minutes, trigger_at, status, prompt, metadata, result_summary, finished_at, updated_at, deleted_at
      ) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, 0)`,
      [
        job.jobId,
        job.projectId,
        job.sessionId,
        job.name,
        job.createdAt ? new Date(job.createdAt) : new Date(),
        job.delayMinutes,
        new Date(job.triggerAt),
        job.status,
        job.prompt,
        JSON.stringify(job.metadata ?? {}),
        job.resultSummary ?? null,
        job.finishedAt ? new Date(job.finishedAt) : null,
        job.updatedAt ? new Date(job.updatedAt) : new Date(),
      ],
    );
  }

  async cancelScheduledJob(
    sessionId: string,
    identifier: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      "UPDATE scheduled_jobs SET status=$3, updated_at=now() WHERE session_id=$1 AND status=$4 AND (job_id=$2 OR name=$2) AND deleted_at = 0",
      [
        sessionId,
        identifier,
        ScheduledJobStatus.CANCELLED,
        ScheduledJobStatus.PENDING,
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async listDueScheduledJobs(
    projectId?: string,
    asOf: Date = new Date(),
  ): Promise<ScheduledJobRecord[]> {
    const params: unknown[] = [ScheduledJobStatus.PENDING, asOf];
    let sql =
      "SELECT * FROM scheduled_jobs WHERE status=$1 AND trigger_at <= $2 AND deleted_at = 0";
    if (projectId) {
      params.push(projectId);
      sql += ` AND project_id=$${params.length}`;
    }
    sql += " ORDER BY trigger_at ASC";
    const result = await this.pool.query(sql, params);
    return result.rows.map((row) => ({
      id: Number(row.id),
      jobId: row.job_id,
      projectId: row.project_id,
      sessionId: row.session_id,
      name: row.name,
      createdAt: row.created_at?.toISOString() ?? new Date().toISOString(),
      delayMinutes: Number(row.delay_minutes ?? 0),
      triggerAt: row.trigger_at.toISOString(),
      status: Number(row.status) as ScheduledJobStatusCode,
      prompt: row.prompt ?? "",
      metadata: row.metadata ?? {},
      resultSummary: row.result_summary ?? undefined,
      finishedAt: row.finished_at?.toISOString() ?? undefined,
      updatedAt: row.updated_at?.toISOString() ?? undefined,
      deletedAt: Number(row.deleted_at ?? 0),
    }));
  }

  async listScheduledJobs(filter?: {
    sessionId?: string | undefined;
    projectId?: string | undefined;
    status?: ScheduledJobStatusCode | undefined;
    limit?: number | undefined;
  }): Promise<ScheduledJobRecord[]> {
    const params: unknown[] = [];
    const wheres: string[] = ["deleted_at = 0"];
    if (filter?.sessionId) {
      params.push(filter.sessionId);
      wheres.push(`session_id = $${params.length}`);
    }
    if (filter?.projectId) {
      params.push(filter.projectId);
      wheres.push(`project_id = $${params.length}`);
    }
    if (filter?.status !== undefined) {
      params.push(filter.status);
      wheres.push(`status = $${params.length}`);
    }
    params.push(filter?.limit ?? 50);
    const sql = `SELECT * FROM scheduled_jobs WHERE ${wheres.join(" AND ")} ORDER BY id DESC LIMIT $${params.length}`;
    const result = await this.pool.query(sql, params);
    return result.rows.map((row) => ({
      id: Number(row.id),
      jobId: row.job_id,
      projectId: row.project_id,
      sessionId: row.session_id,
      name: row.name,
      createdAt: row.created_at?.toISOString() ?? new Date().toISOString(),
      delayMinutes: Number(row.delay_minutes ?? 0),
      triggerAt: row.trigger_at.toISOString(),
      status: Number(row.status) as ScheduledJobStatusCode,
      prompt: row.prompt ?? "",
      metadata: row.metadata ?? {},
      resultSummary: row.result_summary ?? undefined,
      finishedAt: row.finished_at?.toISOString() ?? undefined,
      updatedAt: row.updated_at?.toISOString() ?? undefined,
      deletedAt: Number(row.deleted_at ?? 0),
    }));
  }

  async cancelScheduledJobById(jobId: string): Promise<boolean> {
    const result = await this.pool.query(
      "UPDATE scheduled_jobs SET status=$3, updated_at=now() WHERE (job_id=$1 OR id::text=$1) AND status=$2 AND deleted_at = 0",
      [jobId, ScheduledJobStatus.PENDING, ScheduledJobStatus.CANCELLED],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async updateScheduledJobStatus(
    jobId: string,
    status: ScheduledJobStatusCode,
    summary?: string,
    finishedAt?: string,
  ): Promise<void> {
    await this.pool.query(
      "UPDATE scheduled_jobs SET status=$2, result_summary=COALESCE($3, result_summary), finished_at=COALESCE($4, finished_at), updated_at=now() WHERE job_id=$1 AND deleted_at = 0",
      [
        jobId,
        status,
        summary ?? null,
        finishedAt ? new Date(finishedAt) : null,
      ],
    );
  }
  async recordActionExecution(record: ActionExecutionRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO action_executions(
        execution_id, project_id, session_id, turn_id, task_key,
        caller, action_name, parameters, status, result,
        error_message, duration_ms, created_at
      ) VALUES($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11, $12, $13)`,
      [
        record.executionId,
        record.projectId,
        record.sessionId ?? null,
        record.turnId ?? null,
        record.taskKey ?? null,
        record.caller ?? "unknown",
        record.actionName,
        JSON.stringify(record.parameters ?? {}),
        record.status,
        record.result !== undefined ? JSON.stringify(record.result) : null,
        record.errorMessage ?? null,
        record.durationMs ?? 0,
        record.createdAt ? new Date(record.createdAt) : new Date(),
      ],
    );
  }
  async listActionExecutions(
    filter?: ActionExecutionFilter,
  ): Promise<ActionExecutionRecord[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (filter?.projectId) {
      conditions.push(`project_id = $${idx++}`);
      values.push(filter.projectId);
    }
    if (filter?.sessionId) {
      conditions.push(`session_id = $${idx++}`);
      values.push(filter.sessionId);
    }
    if (filter?.actionName) {
      conditions.push(`action_name = $${idx++}`);
      values.push(filter.actionName);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.max(1, Math.min(filter?.limit ?? 50, 200));
    values.push(limit);

    const query = `
      SELECT id, execution_id, project_id, session_id, turn_id, task_key,
             caller, action_name, parameters, status, result, error_message,
             duration_ms, created_at
      FROM action_executions
      ${whereClause}
      ORDER BY id DESC
      LIMIT $${idx}
    `;

    const res = await this.pool.query(query, values);
    return res.rows.map((row) => ({
      id: row.id,
      executionId: row.execution_id,
      projectId: row.project_id,
      sessionId: row.session_id ?? undefined,
      turnId: row.turn_id ?? undefined,
      taskKey: row.task_key ?? undefined,
      caller: row.caller,
      actionName: row.action_name,
      parameters: row.parameters ?? {},
      status: row.status,
      result: row.result ?? undefined,
      errorMessage: row.error_message ?? undefined,
      durationMs: Number(row.duration_ms ?? 0),
      createdAt: row.created_at
        ? new Date(row.created_at).toISOString()
        : undefined,
    }));
  }
  async close(): Promise<void> {
    await this.pool.end();
  }
  private rowToTurn(row: Record<string, any>): TurnRecord {
    return {
      id: row.turn_id ?? row.id,
      sessionId: row.session_id,
      input: row.input,
      status: row.status,
      runtimeTurnId: row.runtime_turn_id ?? undefined,
      output: row.output ?? undefined,
      error: row.error ?? undefined,
      createdAt: row.created_at.toISOString(),
      startedAt: row.started_at?.toISOString(),
      finishedAt: row.finished_at?.toISOString(),
    };
  }
}

export function newSessionRoute(
  projectId: string,
  configRevision = 1,
): SessionRoute {
  return {
    sessionId: `ses_${randomUUID()}`,
    projectId,
    projectRuntimeId: `project-runtime:${projectId}`,
    runtimeSessionId: null,
    configRevision,
    status: "active",
    lastActiveAt: new Date().toISOString(),
  };
}

/** Maps a `sessions` row to a SessionRoute. */
function toSessionRoute(row: Record<string, any>): SessionRoute {
  return {
    id: Number(row.id),
    sessionId: row.session_id,
    ...(row.title ? { title: row.title } : {}),
    projectId: row.project_id,
    projectRuntimeId: row.project_runtime_id,
    runtimeSessionId: row.runtime_session_id,
    runtime: row.runtime ?? row.metadata?.runtime ?? "unknown",
    workspacePath: row.workspace_path ?? undefined,
    configRevision: row.config_revision,
    status: row.status,
    source: row.source ?? "unknown",
    externalChannel: row.external_channel ?? undefined,
    externalConversationId: row.external_conversation_id ?? undefined,
    externalThreadId: row.external_thread_id ?? undefined,
    lastActiveAt: row.last_active_at.toISOString(),
    createdAt: row.created_at?.toISOString(),
    updatedAt: row.updated_at?.toISOString(),
    deletedAt: Number(row.deleted_at ?? 0),
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : undefined,
  };
}
