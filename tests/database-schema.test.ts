import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getTableConfig } from "drizzle-orm/pg-core";
import { NOT_DELETED, type BaseEntity, type BaseLogRecord } from "../src/domain/types.ts";
import { schema } from "../src/persistence/schema.ts";

describe("database schema definition", () => {
  test("defines the 9 active tables in Drizzle schema without legacy unused tables", () => {
    const tableConfigs = Object.values(schema).map((table) => getTableConfig(table));
    const tableNames = tableConfigs.map((cfg) => cfg.name).sort();

    expect(tableNames).toEqual(
      [
        "action_executions",
        "artifacts",
        "events",
        "inbound_messages",
        "notification_deliveries",
        "scheduled_jobs",
        "sessions",
        "task_executions",
        "turns",
      ].sort(),
    );
    expect(tableNames).not.toContain("projects");
    expect(tableNames).not.toContain("project_triggers");
    expect(tableNames).not.toContain("trigger_intents");

    for (const cfg of tableConfigs) {
      const idCol = cfg.columns.find((c) => c.name === "id");
      expect(idCol).toBeDefined();
      expect(idCol!.primary).toBe(true);
      expect(idCol!.getSQLType()).toBe("bigserial");

      const createdAtCol = cfg.columns.find((c) => c.name === "created_at");
      expect(createdAtCol).toBeDefined();
      expect(createdAtCol!.notNull).toBe(true);
    }

    for (const entityTableName of ["sessions", "scheduled_jobs"]) {
      const cfg = tableConfigs.find((t) => t.name === entityTableName)!;
      const updatedAtCol = cfg.columns.find((c) => c.name === "updated_at");
      const deletedAtCol = cfg.columns.find((c) => c.name === "deleted_at");
      expect(updatedAtCol).toBeDefined();
      expect(updatedAtCol!.notNull).toBe(true);
      expect(deletedAtCol).toBeDefined();
      expect(deletedAtCol!.notNull).toBe(true);
      expect(deletedAtCol!.default).toBe(NOT_DELETED);
    }

    const sessionsCfg = tableConfigs.find((t) => t.name === "sessions")!;
    expect(sessionsCfg.columns.find((c) => c.name === "title")).toBeDefined();
    expect(sessionsCfg.columns.find((c) => c.name === "cursors")).toBeDefined();
    expect(sessionsCfg.columns.find((c) => c.name === "metadata")).toBeDefined();
    expect(sessionsCfg.columns.find((c) => c.name === "repository_id")).toBeUndefined();

    const notificationsCfg = tableConfigs.find((t) => t.name === "notification_deliveries")!;
    expect(notificationsCfg.columns.find((c) => c.name === "details")).toBeDefined();
    expect(notificationsCfg.columns.find((c) => c.name === "error")).toBeUndefined();
    expect(notificationsCfg.columns.find((c) => c.name === "attempts")).toBeUndefined();

    const turnsCfg = tableConfigs.find((t) => t.name === "turns")!;
    expect(turnsCfg.columns.find((c) => c.name === "model")?.notNull).toBe(false);
    expect(turnsCfg.columns.find((c) => c.name === "usage_details")?.notNull).toBe(false);
    for (const tokenCol of [
      "input_tokens",
      "cache_read_tokens",
      "cache_write_tokens",
      "output_tokens",
      "reasoning_tokens",
      "total_tokens",
    ]) {
      const col = turnsCfg.columns.find((c) => c.name === tokenCol);
      expect(col).toBeDefined();
      expect(col!.notNull).toBe(true);
      expect(col!.default).toBe(0);
    }
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
      deletedAt: NOT_DELETED,
    };
    expect(coreEntity.deletedAt).toBe(NOT_DELETED);
    expect(typeof { ...coreEntity, deletedAt: Date.now() }.deletedAt).toBe("number");
  });

  test("keeps schema initialization outside the runtime Store", async () => {
    const [mainSource, storeSource, initSource] = await Promise.all([
      readFile(path.resolve(import.meta.dir, "../src/main.ts"), "utf8"),
      readFile(path.resolve(import.meta.dir, "../src/persistence/store.ts"), "utf8"),
      readFile(path.resolve(import.meta.dir, "../scripts/init-database.ts"), "utf8"),
    ]);

    expect(mainSource).not.toContain("migrate(");
    expect(storeSource).not.toContain("migrate(");
    expect(initSource).toContain("migrate(");
    expect(initSource).toContain("../database/migrations");
  });
});
