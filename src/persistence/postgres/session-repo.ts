import { and, desc, eq, isNull, ne } from "drizzle-orm";
import type { InboundMessageRecord, SessionRoute } from "../../domain/types.ts";
import type { DrizzleDatabase } from "../db.ts";
import { inboundMessages, scheduledJobs, sessions } from "../schema.ts";
import type { ListSessionsOptions } from "../types.ts";
import { toSessionRoute } from "./mappers.ts";

/** Drizzle repository for `sessions` and `inbound_messages`. */
export class PostgresSessionRepo {
  constructor(private readonly db: DrizzleDatabase) {}

  async createSession(route: SessionRoute): Promise<SessionRoute> {
    const source = route.source ?? "unknown";
    const runtime =
      route.runtime ?? (route.metadata?.runtime as string | undefined) ?? "unknown";
    const metadata = { ...(route.metadata ?? {}), runtime };
    const cursors = route.cursors ?? {};
    const now = new Date();

    await this.db.insert(sessions).values({
      sessionId: route.sessionId,
      title: route.title ?? null,
      projectId: route.projectId,
      projectRuntimeId: route.projectRuntimeId,
      runtimeSessionId: route.runtimeSessionId,
      configRevision: route.configRevision,
      status: route.status,
      source,
      runtime,
      workspacePath: route.workspacePath ?? null,
      externalChannel: route.externalChannel ?? null,
      externalConversationId: route.externalConversationId ?? null,
      externalThreadId: route.externalThreadId ?? null,
      lastActiveAt: new Date(route.lastActiveAt),
      cursors,
      metadata,
      createdAt: now,
      updatedAt: now,
      deletedAt: 0,
    });

    return { ...route, source, runtime, metadata };
  }

  async getSession(sessionId: string): Promise<SessionRoute | null> {
    const rows = await this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.sessionId, sessionId), eq(sessions.deletedAt, 0)))
      .limit(1);
    return rows[0] ? toSessionRoute(rows[0]) : null;
  }

  async listSessions(projectId?: string, options?: ListSessionsOptions): Promise<SessionRoute[]> {
    const conditions = [eq(sessions.deletedAt, 0)];
    if (projectId) {
      conditions.push(eq(sessions.projectId, projectId));
    }
    if (!options?.includeTasks) {
      conditions.push(ne(sessions.source, "task"));
    }

    const rows = await this.db
      .select()
      .from(sessions)
      .where(and(...conditions))
      .orderBy(desc(sessions.lastActiveAt));

    return rows.map(toSessionRoute);
  }

  async updateSession(route: SessionRoute): Promise<void> {
    const metadata = {
      ...(route.metadata ?? {}),
      ...(route.runtime ? { runtime: route.runtime } : {}),
    };

    await this.db
      .update(sessions)
      .set({
        projectId: route.projectId,
        projectRuntimeId: route.projectRuntimeId,
        runtimeSessionId: route.runtimeSessionId,
        configRevision: route.configRevision,
        status: route.status,
        lastActiveAt: new Date(route.lastActiveAt),
        cursors: route.cursors ?? {},
        metadata,
        ...(route.workspacePath !== undefined ? { workspacePath: route.workspacePath } : {}),
        ...(route.externalChannel !== undefined
          ? { externalChannel: route.externalChannel }
          : {}),
        ...(route.externalConversationId !== undefined
          ? { externalConversationId: route.externalConversationId }
          : {}),
        ...(route.externalChannel !== undefined
          ? { externalThreadId: route.externalThreadId ?? null }
          : {}),
        ...(route.source !== undefined ? { source: route.source } : {}),
        ...(route.runtime !== undefined ? { runtime: route.runtime } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(sessions.sessionId, route.sessionId), eq(sessions.deletedAt, 0)));
  }

  async updateSessionTitle(sessionId: string, title: string): Promise<boolean> {
    const updated = await this.db
      .update(sessions)
      .set({ title, updatedAt: new Date() })
      .where(and(eq(sessions.sessionId, sessionId), eq(sessions.deletedAt, 0)))
      .returning({ id: sessions.id });
    return updated.length > 0;
  }

  async setTitleIfEmpty(sessionId: string, title: string): Promise<boolean> {
    const updated = await this.db
      .update(sessions)
      .set({ title, updatedAt: new Date() })
      .where(
        and(eq(sessions.sessionId, sessionId), isNull(sessions.title), eq(sessions.deletedAt, 0)),
      )
      .returning({ id: sessions.id });
    return updated.length > 0;
  }

  async findSessionByExternal(
    channel: string,
    conversationId: string,
    threadId?: string,
  ): Promise<SessionRoute | null> {
    const threadCond =
      threadId !== undefined
        ? eq(sessions.externalThreadId, threadId)
        : isNull(sessions.externalThreadId);

    const rows = await this.db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.externalChannel, channel),
          eq(sessions.externalConversationId, conversationId),
          threadCond,
          ne(sessions.status, "archived"),
          eq(sessions.deletedAt, 0),
        ),
      )
      .orderBy(desc(sessions.lastActiveAt))
      .limit(1);

    return rows[0] ? toSessionRoute(rows[0]) : null;
  }

  async claimInboundMessage(message: InboundMessageRecord): Promise<boolean> {
    const inserted = await this.db
      .insert(inboundMessages)
      .values({
        messageId: message.messageId,
        channel: message.channel,
        conversationId: message.conversationId,
        threadId: message.threadId ?? null,
        sessionId: message.sessionId ?? null,
        receivedAt: new Date(message.receivedAt),
        createdAt: new Date(),
      })
      .onConflictDoNothing({ target: inboundMessages.messageId })
      .returning({ id: inboundMessages.id });

    return inserted.length === 1;
  }

  async releaseInboundMessage(messageId: string): Promise<void> {
    await this.db.delete(inboundMessages).where(eq(inboundMessages.messageId, messageId));
  }

  async deleteSession(sessionId: string): Promise<void> {
    const nowTs = Date.now();
    const now = new Date();
    await this.db.transaction(async (tx) => {
      await tx
        .update(scheduledJobs)
        .set({ deletedAt: nowTs, updatedAt: now })
        .where(and(eq(scheduledJobs.sessionId, sessionId), eq(scheduledJobs.deletedAt, 0)));

      await tx
        .update(sessions)
        .set({ deletedAt: nowTs, updatedAt: now })
        .where(and(eq(sessions.sessionId, sessionId), eq(sessions.deletedAt, 0)));
    });
  }
}
