import { describe, expect, test } from "bun:test";
import type { Pool } from "pg";
import { ScheduledJobStatus } from "../src/domain/types.ts";
import { createDrizzleDb } from "../src/persistence/db.ts";
import { PostgresStore, MemoryStore, newSessionRoute } from "../src/persistence/store.ts";
import {
  toActionExecutionRecord,
  toSessionRoute,
  toTurnRecord,
} from "../src/persistence/postgres/mappers.ts";

interface CapturedQuery {
  sql: string;
  values: unknown[];
  inTx: boolean;
}

function createMockDrizzlePool(responder?: (sql: string, values: unknown[]) => unknown[][]) {
  const captured: CapturedQuery[] = [];

  const exec = (inTx: boolean) => async (queryOrSql: unknown, values?: unknown[]) => {
    const sql =
      typeof queryOrSql === "string"
        ? queryOrSql
        : ((queryOrSql as { text?: string }).text ?? "");
    const params =
      values ?? (typeof queryOrSql === "object" && queryOrSql !== null
        ? ((queryOrSql as { values?: unknown[] }).values ?? [])
        : []);
    captured.push({ sql, values: params, inTx });
    const rows = responder ? responder(sql, params) : [];
    return { rows, rowCount: rows.length, fields: [] };
  };

  const mockPool = {
    query: exec(false),
    async connect() {
      return {
        query: exec(true),
        release() {},
      };
    },
    async end() {},
  };

  const db = createDrizzleDb(mockPool as unknown as Pool);
  const store = PostgresStore.fromDrizzle(db);
  return { store, captured };
}

describe("PostgresStore with Drizzle ORM", () => {
  test("updateSession persists external bindings, workspacePath, and cursors without touching title", async () => {
    const { store, captured } = createMockDrizzlePool();
    const route = newSessionRoute("proj-1");
    route.title = "Should Not Be Overwritten";
    route.workspacePath = "/tmp/ws/ses_1";
    route.externalChannel = "feishu";
    route.externalConversationId = "oc_123";
    route.externalThreadId = "om_456";
    route.cursors = { web: 12, feishu: 9 };

    await store.updateSession(route);

    expect(captured).toHaveLength(1);
    const query = captured[0]!;
    expect(query.sql).toContain('update "sessions" set');
    expect(query.sql).toContain('"external_channel"');
    expect(query.sql).toContain('"external_conversation_id"');
    expect(query.sql).toContain('"external_thread_id"');
    expect(query.sql).toContain('"workspace_path"');
    expect(query.sql).toContain('"cursors"');
    expect(query.sql).not.toContain('"title"');
    expect(query.values).toContain("feishu");
    expect(query.values).toContain("oc_123");
    expect(query.values).toContain("om_456");
    expect(query.values).toContain("/tmp/ws/ses_1");
  });

  test("updateTurn executes a single partial UPDATE without a preceding SELECT", async () => {
    const { store, captured } = createMockDrizzlePool(() => [[42]]);

    await store.updateTurn("turn_1", {
      status: "completed",
      output: "done",
    });

    expect(captured).toHaveLength(1);
    const query = captured[0]!;
    expect(query.sql).toStartWith('update "turns" set');
    expect(query.sql).toContain('"status" = $1');
    expect(query.sql).toContain('"output" = $2');
    expect(query.sql).not.toContain('"input"');
    expect(query.sql).not.toContain('"error"');
    expect(query.sql).toContain('returning "id"');
    expect(query.values).toEqual(["completed", "done", "turn_1"]);
  });

  test("updateTurn throws when the target turn does not exist", async () => {
    const { store } = createMockDrizzlePool(() => []);

    await expect(store.updateTurn("missing_turn", { status: "failed" })).rejects.toThrow(
      "turn not found: missing_turn",
    );
  });

  test("findSessionByExternal uses IS NULL when threadId is omitted and equality when provided", async () => {
    const withoutThread = createMockDrizzlePool();
    await withoutThread.store.findSessionByExternal("feishu", "oc_1");
    expect(withoutThread.captured[0]!.sql).toContain('"external_thread_id" is null');

    const withThread = createMockDrizzlePool();
    await withThread.store.findSessionByExternal("feishu", "oc_1", "om_9");
    expect(withThread.captured[0]!.sql).toContain('"external_thread_id" = $3');
    expect(withThread.captured[0]!.values).toContain("om_9");
  });

  test("deleteSession runs inside a transaction soft-deleting scheduled_jobs and sessions", async () => {
    const { store, captured } = createMockDrizzlePool();

    await store.deleteSession("ses_del");

    expect(captured.map((q) => q.sql.toLowerCase())).toEqual([
      "begin",
      expect.stringContaining('update "scheduled_jobs" set'),
      expect.stringContaining('update "sessions" set'),
      "commit",
    ]);
  });

  test("cancelScheduledJobById avoids numeric id matching for UUID/string job IDs", async () => {
    const strCase = createMockDrizzlePool(() => [[1]]);
    expect(await strCase.store.cancelScheduledJobById("job_abc")).toBe(true);
    expect(strCase.captured[0]!.sql).toContain('"scheduled_jobs"."job_id" = $3');
    expect(strCase.captured[0]!.sql).not.toContain('"scheduled_jobs"."id" =');

    const numCase = createMockDrizzlePool(() => [[1]]);
    expect(await numCase.store.cancelScheduledJobById("42")).toBe(true);
    expect(numCase.captured[0]!.sql).toContain('"scheduled_jobs"."id" = $4');
  });

  test("mappers convert typed Drizzle rows accurately without undefined leaks", () => {
    const now = new Date("2026-11-20T12:00:00.000Z");
    const session = toSessionRoute({
      id: 7,
      sessionId: "ses_7",
      title: null,
      projectId: "proj",
      projectRuntimeId: "project-runtime:proj",
      runtimeSessionId: null,
      configRevision: 1,
      status: "active",
      source: "feishu",
      runtime: "codex",
      workspacePath: "/ws/ses_7",
      externalChannel: "feishu",
      externalConversationId: "oc_1",
      externalThreadId: null,
      lastActiveAt: now,
      cursors: { feishu: 5 },
      metadata: { runtime: "codex" },
      createdAt: now,
      updatedAt: now,
      deletedAt: 0,
    });

    expect(session.id).toBe(7);
    expect("title" in session).toBe(false);
    expect("externalThreadId" in session).toBe(false);
    expect(session.cursors).toEqual({ feishu: 5 });
    expect(session.workspacePath).toBe("/ws/ses_7");

    const turn = toTurnRecord({
      id: 9,
      turnId: "turn_9",
      sessionId: "ses_7",
      input: "hi",
      status: "completed",
      runtimeTurnId: null,
      output: "ok",
      error: null,
      startedAt: now,
      finishedAt: now,
      createdAt: now,
    });
    expect(turn.id).toBe("turn_9");
    expect("error" in turn).toBe(false);
    expect(turn.output).toBe("ok");

    const action = toActionExecutionRecord({
      id: 11,
      executionId: "act_11",
      projectId: "proj",
      sessionId: "ses_7",
      turnId: null,
      taskKey: null,
      caller: "agent",
      actionName: "send_notification",
      parameters: { title: "hi" },
      status: "success",
      result: { delivered: true },
      errorMessage: null,
      durationMs: 15,
      createdAt: now,
    });
    expect(typeof action.id).toBe("number");
    expect(action.id).toBe(11);
    expect("errorMessage" in action).toBe(false);
  });
});

describe("MemoryStore behavior consistency", () => {
  test("clones returned sessions and sorts notification deliveries newest-first", async () => {
    const store = new MemoryStore();
    const route = newSessionRoute("proj-mem");
    await store.createSession(route);

    const fetched = await store.getSession(route.sessionId);
    fetched!.status = "archived";
    expect((await store.getSession(route.sessionId))?.status).toBe("active");

    await store.recordNotificationDelivery({
      id: "del_1",
      projectId: "proj-mem",
      configs: [],
      message: { title: "old", text: "1" },
      status: "sent",
      details: [],
      createdAt: "2026-11-20T01:00:00.000Z",
    });
    await store.recordNotificationDelivery({
      id: "del_2",
      projectId: "proj-mem",
      configs: [],
      message: { title: "new", text: "2" },
      status: "sent",
      details: [],
      createdAt: "2026-11-20T02:00:00.000Z",
    });

    const deliveries = await store.listNotificationDeliveries({ limit: 1 });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.id).toBe("del_2");
  });

  test("excludes soft-deleted scheduled jobs from due/list/cancel queries", async () => {
    const store = new MemoryStore();
    await store.createScheduledJob({
      jobId: "job_deleted",
      projectId: "proj-mem",
      sessionId: "ses_1",
      name: "check",
      delayMinutes: 1,
      triggerAt: "2026-11-20T01:00:00.000Z",
      status: ScheduledJobStatus.PENDING,
      prompt: "hi",
      metadata: {},
      deletedAt: 123456,
    });

    expect(await store.listDueScheduledJobs("proj-mem", new Date("2026-11-20T02:00:00.000Z"))).toEqual([]);
    expect(await store.listScheduledJobs({ projectId: "proj-mem" })).toEqual([]);
    expect(await store.cancelScheduledJobById("job_deleted")).toBe(false);
  });
});
