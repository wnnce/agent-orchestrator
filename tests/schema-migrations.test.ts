import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { BaseEntity, BaseLogRecord, SessionRoute, TaskExecutionRecord, ScheduledJobRecord } from "../src/domain/types.ts";

describe("Database Migration Standards (Plan B - Pragmatic Industrial Design)", () => {
  test("All tables in 001 and 002 use numeric BIGSERIAL PRIMARY KEY and enforce Plan B classification", async () => {
    const migration001Path = path.resolve(import.meta.dir, "../migrations/001_initial.sql");
    const migration002Path = path.resolve(import.meta.dir, "../migrations/002_task_and_action.sql");

    const sql001 = await readFile(migration001Path, "utf-8");
    const sql002 = await readFile(migration002Path, "utf-8");
    const combinedSql = `${sql001}\n${sql002}`;

    // Extract all CREATE TABLE statements
    const createTableRegex = /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\);/gi;
    const tables: { name: string; body: string }[] = [];
    let match;
    while ((match = createTableRegex.exec(combinedSql)) !== null) {
      if (match[1] && match[2]) {
        tables.push({ name: match[1], body: match[2] });
      }
    }

    expect(tables.length).toBeGreaterThanOrEqual(11);

    // 1. Core entity tables: Must have id BIGSERIAL, created_at, updated_at, deleted_at BIGINT DEFAULT 0
    const coreEntityTables = ["projects", "sessions", "scheduled_jobs", "project_triggers"];
    for (const tableName of coreEntityTables) {
      const found = tables.find((t) => t.name === tableName);
      expect(found).toBeDefined();
      if (!found) continue;

      const body = found.body;
      expect(body).toMatch(/id\s+BIGSERIAL\s+PRIMARY\s+KEY/i);
      expect(body).not.toMatch(/TEXT\s+PRIMARY\s+KEY/i);
      expect(body).not.toMatch(/VARCHAR(\(\d+\))?\s+PRIMARY\s+KEY/i);

      expect(body).toMatch(/created_at\s+TIMESTAMPTZ\s+NOT\s+NULL/i);
      expect(body).toMatch(/updated_at\s+TIMESTAMPTZ\s+NOT\s+NULL/i);
      expect(body).toMatch(/deleted_at\s+BIGINT\s+NOT\s+NULL\s+DEFAULT\s+0/i);
      expect(body).not.toMatch(/deleted_at\s+TIMESTAMP/i);
    }

    // 2. Append-Only log/audit tables: Must have id BIGSERIAL, created_at, but NO deleted_at
    const appendOnlyTables = ["events", "turns", "artifacts", "task_executions"];
    for (const tableName of appendOnlyTables) {
      const found = tables.find((t) => t.name === tableName);
      expect(found).toBeDefined();
      if (!found) continue;

      const body = found.body;
      expect(body).toMatch(/id\s+BIGSERIAL\s+PRIMARY\s+KEY/i);
      expect(body).not.toMatch(/TEXT\s+PRIMARY\s+KEY/i);
      expect(body).not.toMatch(/VARCHAR(\(\d+\))?\s+PRIMARY\s+KEY/i);

      expect(body).toMatch(/created_at\s+TIMESTAMPTZ\s+NOT\s+NULL/i);
      // Plan B: No deleted_at on append-only event/turn/execution logs
      expect(body).not.toMatch(/deleted_at/i);
    }

    // 3. Transient dedup/queue tables: Must have id BIGSERIAL, created_at, but NO deleted_at
    const transientTables = ["trigger_intents", "inbound_messages", "notification_deliveries"];
    for (const tableName of transientTables) {
      const found = tables.find((t) => t.name === tableName);
      expect(found).toBeDefined();
      if (!found) continue;

      const body = found.body;
      expect(body).toMatch(/id\s+BIGSERIAL\s+PRIMARY\s+KEY/i);
      expect(body).not.toMatch(/TEXT\s+PRIMARY\s+KEY/i);
      expect(body).not.toMatch(/VARCHAR(\(\d+\))?\s+PRIMARY\s+KEY/i);

      expect(body).toMatch(/created_at\s+TIMESTAMPTZ\s+NOT\s+NULL/i);
      expect(body).not.toMatch(/deleted_at/i);
    }
  });

  test("BaseEntity and BaseLogRecord TypeScript types compile and reflect Plan B semantics", () => {
    const logRecord: BaseLogRecord = {
      id: 1,
      createdAt: new Date().toISOString(),
    };
    expect(logRecord.id).toBe(1);

    const coreEntity: BaseEntity = {
      id: 100,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deletedAt: 0,
    };
    expect(coreEntity.deletedAt).toBe(0);

    const deletedEntity: BaseEntity = {
      ...coreEntity,
      deletedAt: Date.now(),
    };
    expect(typeof deletedEntity.deletedAt).toBe("number");
  });
});
