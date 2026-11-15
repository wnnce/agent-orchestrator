import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { BaseEntity, BaseLogRecord } from "../src/domain/types.ts";

describe("database schema definition", () => {
  test("defines the complete fresh-database schema without upgrade statements", async () => {
    const schemaPath = path.resolve(import.meta.dir, "../database/schema.sql");
    const sql = await readFile(schemaPath, "utf8");
    const createTableRegex = /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\);/gi;
    const tables: { name: string; body: string }[] = [];
    let match = createTableRegex.exec(sql);

    while (match !== null) {
      tables.push({ name: match[1]!, body: match[2]! });
      match = createTableRegex.exec(sql);
    }

    expect(tables.map((table) => table.name).sort()).toEqual(
      [
        "action_executions",
        "artifacts",
        "events",
        "inbound_messages",
        "notification_deliveries",
        "project_triggers",
        "scheduled_jobs",
        "sessions",
        "task_executions",
        "trigger_intents",
        "turns",
      ].sort(),
    );
    expect(tables.some((table) => table.name === "projects")).toBe(false);
    expect(sql).not.toMatch(/^\s*(ALTER|DROP|UPDATE|DELETE)\s+/gim);

    for (const table of tables) {
      expect(table.body).toMatch(/id\s+BIGSERIAL\s+PRIMARY\s+KEY/i);
      expect(table.body).not.toMatch(/(?:TEXT|VARCHAR(?:\(\d+\))?)\s+PRIMARY\s+KEY/i);
      expect(table.body).toMatch(/created_at\s+TIMESTAMPTZ\s+NOT\s+NULL/i);
    }

    const coreEntityTables = ["sessions", "scheduled_jobs", "project_triggers"];
    for (const tableName of coreEntityTables) {
      const body = tables.find((table) => table.name === tableName)?.body;
      expect(body).toBeDefined();
      expect(body!).toMatch(/updated_at\s+TIMESTAMPTZ\s+NOT\s+NULL/i);
      expect(body!).toMatch(/deleted_at\s+BIGINT\s+NOT\s+NULL\s+DEFAULT\s+0/i);
    }

    const sessions = tables.find((table) => table.name === "sessions")?.body;
    expect(sessions).toMatch(/title\s+VARCHAR\(255\)/i);
    expect(sessions).toMatch(/metadata\s+JSONB/i);

    const notifications = tables.find((table) => table.name === "notification_deliveries")?.body;
    expect(notifications).toMatch(/details\s+JSONB/i);
    expect(notifications).not.toMatch(/\berror\b|\battempts\b/i);
  });

  test("base persistence types retain entity and append-only semantics", () => {
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
    expect(typeof { ...coreEntity, deletedAt: Date.now() }.deletedAt).toBe("number");
  });

  test("keeps schema initialization outside the runtime Store", async () => {
    const [mainSource, storeSource, initSource] = await Promise.all([
      readFile(path.resolve(import.meta.dir, "../src/main.ts"), "utf8"),
      readFile(path.resolve(import.meta.dir, "../src/persistence/store.ts"), "utf8"),
      readFile(path.resolve(import.meta.dir, "../scripts/init-database.ts"), "utf8"),
    ]);

    expect(mainSource).not.toContain(".migrate(");
    expect(storeSource).not.toContain("schema.sql");
    expect(storeSource).not.toMatch(/(?:INSERT INTO|FROM)\s+projects\b/i);
    expect(initSource).toContain("../database/schema.sql");
    expect(initSource).toContain('client.query("BEGIN")');
  });
});
