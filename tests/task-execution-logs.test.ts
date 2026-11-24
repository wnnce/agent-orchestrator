import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../src/config/config.ts";
import type { ProjectConfig, TaskExecutionLogRecord } from "../src/domain/types.ts";
import { Gateway } from "../src/gateway/server.ts";
import { Logger, type LogEntry } from "../src/observability/logger.ts";
import { MemoryStore } from "../src/persistence/store.ts";
import { ProjectManager } from "../src/project/manager.ts";
import { RuntimeRegistry } from "../src/runtime/registry.ts";
import { FakeRuntime } from "../src/runtime/runtime.ts";
import { TaskLogBuffer } from "../src/task/index.ts";

function makeEntry(message: string, level: LogEntry["level"] = "info"): LogEntry {
  return {
    timestamp: new Date().toISOString(),
    level,
    message,
  };
}

describe("TaskLogBuffer async batching and circuit breaker", () => {
  const silentLogger = new Logger({ sink: () => {} });

  test("triggers async batch flush at soft threshold (256), skips concurrent triggers while in-flight, and chains remaining batches", async () => {
    const writtenBatches: number[] = [];
    const persistedSequences: number[] = [];
    let releaseFirstBatch!: () => void;
    const firstBatchGate = new Promise<void>((resolve) => {
      releaseFirstBatch = resolve;
    });

    const buffer = new TaskLogBuffer({
      executionId: "exec_batch",
      projectId: "demo",
      taskKey: "demo:heavy",
      flushThreshold: 256,
      maxBatchSize: 1024,
      hostLogger: silentLogger,
      writer: async (entries) => {
        writtenBatches.push(entries.length);
        if (writtenBatches.length === 1) {
          await firstBatchGate;
        }
        for (const item of entries) {
          persistedSequences.push(item.sequence);
        }
      },
    });

    // 255 entries: below soft threshold -> no write yet
    for (let i = 1; i <= 255; i++) {
      buffer.push(makeEntry(`log-${i}`));
    }
    expect(writtenBatches).toEqual([]);
    expect(buffer.pendingCount).toBe(255);

    // 256th entry triggers async batch #1
    buffer.push(makeEntry("log-256"));
    expect(writtenBatches).toEqual([256]);

    // While batch #1 is in-flight, pushing 300 more entries must NOT start a concurrent write
    for (let i = 257; i <= 556; i++) {
      buffer.push(makeEntry(`log-${i}`));
    }
    expect(writtenBatches).toEqual([256]);

    // Release batch #1 -> buffer removes first 256 and automatically chains batch #2 with all 300
    releaseFirstBatch();
    await buffer.flush();

    expect(writtenBatches).toEqual([256, 300]);
    expect(buffer.pendingCount).toBe(0);
    expect(buffer.persistedCount).toBe(556);
    expect(persistedSequences).toHaveLength(556);
    expect(persistedSequences[0]).toBe(1);
    expect(persistedSequences[555]).toBe(556);
  });

  test("trips circuit breaker after > 3 consecutive failures, drops all buffered and future logs, and resets counter on success", async () => {
    let shouldFail = true;
    let callCount = 0;

    const buffer = new TaskLogBuffer({
      executionId: "exec_cb",
      projectId: "demo",
      taskKey: "demo:flaky",
      flushThreshold: 2,
      maxConsecutiveFailures: 3,
      hostLogger: silentLogger,
      writer: async () => {
        callCount += 1;
        if (shouldFail) {
          throw new Error(`db failure #${callCount}`);
        }
      },
    });

    // Failures 1, 2, 3: tolerated (not tripped yet)
    buffer.push(makeEntry("m1"));
    buffer.push(makeEntry("m2")); // failure 1
    await Bun.sleep(5);
    expect(buffer.consecutiveFailureCount).toBe(1);
    expect(buffer.isDisabled).toBe(false);

    buffer.push(makeEntry("m3")); // failure 2
    await Bun.sleep(5);
    expect(buffer.consecutiveFailureCount).toBe(2);
    expect(buffer.isDisabled).toBe(false);

    buffer.push(makeEntry("m4")); // failure 3
    await Bun.sleep(5);
    expect(buffer.consecutiveFailureCount).toBe(3);
    expect(buffer.isDisabled).toBe(false);
    expect(buffer.pendingCount).toBe(4);

    // Succeed once -> resets consecutiveFailures to 0 and clears buffer
    shouldFail = false;
    buffer.push(makeEntry("m5"));
    await buffer.flush();
    expect(buffer.consecutiveFailureCount).toBe(0);
    expect(buffer.isDisabled).toBe(false);
    expect(buffer.pendingCount).toBe(0);
    expect(buffer.persistedCount).toBe(5);

    // Now fail 4 consecutive times (> 3) -> trips circuit breaker and drops everything
    shouldFail = true;
    buffer.push(makeEntry("f1"));
    buffer.push(makeEntry("f2")); // fail 1
    await Bun.sleep(5);
    buffer.push(makeEntry("f3")); // fail 2
    await Bun.sleep(5);
    buffer.push(makeEntry("f4")); // fail 3
    await Bun.sleep(5);
    expect(buffer.isDisabled).toBe(false);

    buffer.push(makeEntry("f5")); // fail 4 (> 3) -> trip!
    await Bun.sleep(5);
    expect(buffer.isDisabled).toBe(true);
    expect(buffer.pendingCount).toBe(0);

    const callsAtTrip = callCount;
    // Future pushes and flush must be completely ignored
    for (let i = 0; i < 10; i++) {
      buffer.push(makeEntry(`ignored-${i}`));
    }
    await buffer.flush();
    expect(buffer.pendingCount).toBe(0);
    expect(callCount).toBe(callsAtTrip);
  });

  test("Logger.withListener captures debug+ logs, propagates to child loggers, and redacts secrets", () => {
    const sinkLines: string[] = [];
    const captured: LogEntry[] = [];
    const base = new Logger({ level: "info", sink: (line) => sinkLines.push(line) });
    const taskLogger = base.withListener(
      { projectId: "demo", taskKey: "demo:t1" },
      (entry) => captured.push(entry),
      { captureAllLevels: true },
    );

    taskLogger.debug("debug detail", { apiKey: "sk-secret", count: 3 });
    taskLogger.child({ step: "sync" }).info("synced", { token: "tok_abc", ok: true });

    // Host sink respects level="info" (only 1 line written)
    expect(sinkLines).toHaveLength(1);
    // Listener captures both debug and info with sanitized fields
    expect(captured).toHaveLength(2);
    expect(captured[0]).toMatchObject({
      level: "debug",
      message: "debug detail",
      fields: { apiKey: "[REDACTED]", count: 3 },
    });
    expect(captured[1]).toMatchObject({
      level: "info",
      message: "synced",
      fields: { step: "sync", token: "[REDACTED]", ok: true },
    });
  });
});

describe("TS task execution logs end-to-end persistence and API", () => {
  let root: string;
  let projectDir: string;
  let store: MemoryStore;
  let manager: ProjectManager;
  let gateway: Gateway;
  let batchSizes: number[];

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "ao-ts-logs-"));
    projectDir = path.join(root, "projects", "demo");
    await mkdir(path.join(projectDir, "tasks"), { recursive: true });

    store = new MemoryStore();
    batchSizes = [];
    const origAppend = store.appendTaskExecutionLogs.bind(store);
    store.appendTaskExecutionLogs = async (logs: readonly TaskExecutionLogRecord[]) => {
      batchSizes.push(logs.length);
      return origAppend(logs);
    };

    const logger = new Logger({ sink: () => {} });
    const registry = new RuntimeRegistry(logger);
    registry.register("fake", () => new FakeRuntime());

    const project: ProjectConfig = {
      id: "demo",
      displayName: "Demo",
      description: "Demo project",
      projectDir,
      routing: { projectId: "demo", displayName: "Demo" },
      repository: { url: "", baseBranch: "main" },
      runtime: { type: "fake" },
    };

    const config: AppConfig = {
      defaultRuntime: "fake",
      host: "127.0.0.1",
      port: 7070,
      logLevel: "error",
      dataDir: path.join(root, "data"),
      artifactDir: path.join(root, "artifacts"),
      projectConfigPath: path.join(root, "projects"),
      allowUnauthenticated: true,
      routerBaseUrl: "http://localhost:8317/v1",
      feishu: { enabled: false },
    };

    manager = new ProjectManager([project], store, config, logger, undefined, undefined, registry);
    await manager.start();
    gateway = new Gateway(config, store, manager, logger);
  });

  afterEach(async () => {
    await gateway.stop();
    await manager.stop();
    await rm(root, { recursive: true, force: true });
  });

  test("persists high-volume logs in batches, preserves logs on failure, and serves paginated/filtered logs via API", async () => {
    await writeFile(
      path.join(projectDir, "tasks", "loggy.ts"),
      `
export default function (api) {
  api.registerTask({
    id: "bulk-log",
    name: "Bulk Log Task",
    cron: "0 0 * * *",
    enabled: false,
    async run(ctx) {
      ctx.logger.debug("starting bulk run", { secretToken: "top-secret" });
      for (let i = 1; i <= 600; i++) {
        if (i % 200 === 0) {
          ctx.logger.warn("checkpoint", { index: i });
        } else {
          ctx.logger.info("item processed", { index: i });
        }
      }
      ctx.logger.error("non-fatal error sample", { code: "E_SAMPLE" });
    },
  });

  api.registerTask({
    id: "fail-with-logs",
    name: "Fail With Logs",
    cron: "0 0 * * *",
    enabled: false,
    async run(ctx) {
      ctx.logger.info("step 1 ok");
      ctx.logger.warn("step 2 unstable", { retry: 1 });
      throw new Error("boom in step 3");
    },
  });
}
`,
    );

    const projectRt = manager.get("demo");
    await projectRt.runTask("bulk-log");
    await projectRt.taskEngine.drain();

    const execs = await store.listTaskExecutions("demo:bulk-log", 5);
    expect(execs).toHaveLength(1);
    const execId = execs[0]!.executionId;

    // Verify batch insertion occurred (far fewer calls than 602 individual rows!)
    expect(batchSizes.length).toBeLessThanOrEqual(4);
    expect(batchSizes.reduce((a, b) => a + b, 0)).toBe(602);

    // Page 1 via API
    const p1Res = await gateway.app.request(`/tasks/executions/${execId}/logs?limit=250`);
    expect(p1Res.status).toBe(200);
    const p1 = (await p1Res.json()) as {
      logs: TaskExecutionLogRecord[];
      hasMore: boolean;
      nextAfterSeq: number;
    };
    expect(p1.logs).toHaveLength(250);
    expect(p1.hasMore).toBe(true);
    expect(p1.nextAfterSeq).toBe(250);
    expect(p1.logs[0]?.level).toBe("debug");
    expect(p1.logs[0]?.fields?.secretToken).toBe("[REDACTED]");

    // Level filter via API
    const warnRes = await gateway.app.request(`/tasks/executions/${execId}/logs?level=warn`);
    expect(warnRes.status).toBe(200);
    const warnData = (await warnRes.json()) as {
      logs: TaskExecutionLogRecord[];
      hasMore: boolean;
    };
    expect(warnData.logs).toHaveLength(3);
    expect(warnData.hasMore).toBe(false);

    // Failed execution must still flush logs written before throwing
    await projectRt.runTask("fail-with-logs");
    await projectRt.taskEngine.drain();

    const failedExecs = await store.listTaskExecutions("demo:fail-with-logs", 5);
    expect(failedExecs).toHaveLength(1);
    expect(failedExecs[0]?.status).toBe("failed");

    const failLogsRes = await gateway.app.request(
      `/tasks/executions/${failedExecs[0]!.executionId}/logs`,
    );
    expect(failLogsRes.status).toBe(200);
    const failLogs = (await failLogsRes.json()) as { logs: TaskExecutionLogRecord[] };
    expect(failLogs.logs.map((l) => `${l.level}:${l.message}`)).toEqual([
      "info:step 1 ok",
      "warn:step 2 unstable",
    ]);
  });
});
