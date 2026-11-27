import { describe, expect, test } from "bun:test";
import { ScheduledJobStatus } from "../src/domain/types.ts";
import { createProjectsRouter } from "../src/gateway/routes/projects.ts";
import { TtlSingleflightCache } from "../src/gateway/stats-cache.ts";
import { MemoryStore } from "../src/persistence/memory/index.ts";
import type { ProjectManager } from "../src/project/manager.ts";

function makeProjectManagerStub(
  projectsMap: Record<
    string,
    {
      tasks?: Array<{ taskId: string; enabled: boolean }>;
    }
  >,
): ProjectManager {
  return {
    getDefaultRuntime: () => "codex",
    list: () =>
      Object.keys(projectsMap).map((projectId) => ({
        routing: { projectId, displayName: projectId },
      })),
    get: (projectId: string) => {
      const entry = projectsMap[projectId];
      if (!entry) throw new Error(`project not found: ${projectId}`);
      return {
        listTasks: async () => entry.tasks ?? [],
      };
    },
    listSkills: async (projectId: string) => {
      if (!projectsMap[projectId]) throw new Error(`project not found: ${projectId}`);
      return [];
    },
  } as unknown as ProjectManager;
}

describe("Project Overview & Metrics Store + Gateway", () => {
  test("aggregates overview counts, attention items, and live work accurately", async () => {
    const store = new MemoryStore();
    const now = new Date("2026-11-26T12:00:00.000Z");

    // Interactive sessions (counted in overview)
    await store.createSession({
      sessionId: "ses_active_1",
      title: "Fix gateway timeout",
      projectId: "demo",
      projectRuntimeId: "project-runtime:demo",
      runtimeSessionId: null,
      configRevision: 1,
      status: "active",
      source: "web",
      runtime: "codex",
      model: "gpt-5.4",
      lastActiveAt: "2026-11-26T11:55:00.000Z",
      createdAt: "2026-11-26T10:00:00.000Z",
    });
    await store.createSession({
      sessionId: "ses_idle_1",
      title: "Old chat",
      projectId: "demo",
      projectRuntimeId: "project-runtime:demo",
      runtimeSessionId: null,
      configRevision: 1,
      status: "idle",
      source: "feishu",
      externalChannel: "feishu",
      runtime: "claude",
      lastActiveAt: "2026-11-26T09:00:00.000Z",
      createdAt: "2026-11-26T08:00:00.000Z",
    });
    // Task session (must be excluded from interactive overview session counts)
    await store.createSession({
      sessionId: "ses_task_1",
      projectId: "demo",
      projectRuntimeId: "project-runtime:demo",
      runtimeSessionId: null,
      configRevision: 1,
      status: "active",
      source: "task",
      runtime: "codex",
      lastActiveAt: "2026-11-26T11:50:00.000Z",
      createdAt: "2026-11-26T11:50:00.000Z",
    });

    // Pipeline runs: one waiting_confirmation, one running, one recent failed
    await store.pipelines.createRun(
      {
        runId: "prun_confirm",
        projectId: "demo",
        pipelineId: "feature-dev",
        pipelineVersion: 1,
        title: "Add export feature",
        data: {},
        metadata: {},
        currentNodeId: "design_review",
        status: "waiting_confirmation",
        workspaceStatus: "none",
        loopCounts: {},
        latestNodeOutputs: {},
        createdBy: "web",
        stateVersion: 1,
        createdAt: "2026-11-26T10:00:00.000Z",
        updatedAt: "2026-11-26T11:00:00.000Z",
      },
      {
        nodeRunId: "pnr_confirm_1",
        runId: "prun_confirm",
        projectId: "demo",
        pipelineId: "feature-dev",
        nodeId: "design_review",
        executorType: "human",
        status: "waiting_confirmation",
        inputContext: {},
        stepState: {},
        pollCount: 0,
        reminderSent: false,
        createdAt: "2026-11-26T10:00:00.000Z",
        updatedAt: "2026-11-26T11:00:00.000Z",
      },
    );

    await store.pipelines.createRun(
      {
        runId: "prun_running",
        projectId: "demo",
        pipelineId: "feature-dev",
        pipelineVersion: 1,
        title: "Refactor auth",
        data: {},
        metadata: {},
        currentNodeId: "implement",
        status: "running",
        workspaceStatus: "none",
        loopCounts: {},
        latestNodeOutputs: {},
        createdBy: "web",
        stateVersion: 1,
        createdAt: "2026-11-26T11:30:00.000Z",
        updatedAt: "2026-11-26T11:58:00.000Z",
      },
      {
        nodeRunId: "pnr_running_1",
        runId: "prun_running",
        projectId: "demo",
        pipelineId: "feature-dev",
        nodeId: "implement",
        executorType: "agent",
        status: "running",
        inputContext: {},
        stepState: {},
        pollCount: 0,
        reminderSent: false,
        startedAt: "2026-11-26T11:31:00.000Z",
        createdAt: "2026-11-26T11:30:00.000Z",
        updatedAt: "2026-11-26T11:58:00.000Z",
      },
    );

    await store.recordTaskExecution({
      executionId: "texec_fail_1",
      taskKey: "demo:daily-sync",
      projectId: "demo",
      taskId: "daily-sync",
      taskType: "project_task",
      status: "failed",
      startedAt: "2026-11-26T09:00:00.000Z",
      durationMs: 1200,
      actionsSummary: {},
      errorMessage: "GitHub API 403",
    });

    await store.createScheduledJob({
      jobId: "job_pending_1",
      projectId: "demo",
      sessionId: "ses_active_1",
      name: "Check PR merge",
      delayMinutes: 15,
      triggerAt: "2026-11-26T12:15:00.000Z",
      status: ScheduledJobStatus.PENDING,
      prompt: "check PR",
      metadata: {},
      createdAt: "2026-11-26T12:00:00.000Z",
      updatedAt: "2026-11-26T12:00:00.000Z",
    });

    const overview = await store.getProjectOverview("demo", { now });
    expect(overview.sessions).toEqual({
      active: 1,
      idle: 1,
      suspended: 0,
      archived: 0,
      total: 2,
    });
    expect(overview.pipelines.waitingConfirmation).toBe(1);
    expect(overview.pipelines.running).toBe(1);
    expect(overview.scheduledJobs.pending).toBe(1);
    expect(overview.attention.waitingConfirmations).toHaveLength(1);
    expect(overview.attention.waitingConfirmations[0]?.runId).toBe("prun_confirm");
    expect(overview.attention.failedTaskExecutions).toHaveLength(1);
    expect(overview.live.activeSessions).toHaveLength(1);
    expect(overview.live.activePipelineNodes).toHaveLength(1);
    expect(overview.live.activePipelineNodes[0]?.runTitle).toBe("Refactor auth");
    expect(overview.live.upcomingJobs).toHaveLength(1);
  });

  test("aggregates daily metrics, token usage, cache hit rate, and model/source breakdowns", async () => {
    const store = new MemoryStore();
    const now = new Date("2026-11-26T12:00:00.000Z");

    await store.createSession({
      sessionId: "ses_web",
      projectId: "demo",
      projectRuntimeId: "project-runtime:demo",
      runtimeSessionId: null,
      configRevision: 1,
      status: "active",
      source: "web",
      model: "gpt-5.4",
      lastActiveAt: "2026-11-26T10:00:00.000Z",
      createdAt: "2026-11-25T10:00:00.000Z",
    });
    await store.createSession({
      sessionId: "ses_task",
      projectId: "demo",
      projectRuntimeId: "project-runtime:demo",
      runtimeSessionId: null,
      configRevision: 1,
      status: "archived",
      source: "task",
      model: "claude-sonnet-4",
      lastActiveAt: "2026-11-26T08:00:00.000Z",
      createdAt: "2026-11-26T08:00:00.000Z",
    });

    await store.createTurn({
      id: "turn_1",
      sessionId: "ses_web",
      input: "hello",
      status: "completed",
      createdAt: "2026-11-25T10:00:00.000Z",
      usage: {
        model: "gpt-5.4",
        inputTokens: 1000,
        cacheReadTokens: 3000,
        cacheWriteTokens: 0,
        outputTokens: 500,
        reasoningTokens: 0,
        totalTokens: 4500,
      },
    });
    await store.createTurn({
      id: "turn_2",
      sessionId: "ses_task",
      input: "run daily sync",
      status: "completed",
      createdAt: "2026-11-26T08:00:00.000Z",
      usage: {
        model: "claude-sonnet-4",
        inputTokens: 2000,
        cacheReadTokens: 2000,
        cacheWriteTokens: 100,
        outputTokens: 400,
        reasoningTokens: 0,
        totalTokens: 4500,
      },
    });

    await store.recordTaskExecution({
      executionId: "texec_ok",
      taskKey: "demo:t1",
      projectId: "demo",
      taskId: "t1",
      taskType: "project_task",
      status: "success",
      startedAt: "2026-11-26T08:05:00.000Z",
      actionsSummary: {},
    });
    await store.recordTaskExecution({
      executionId: "texec_err",
      taskKey: "demo:t1",
      projectId: "demo",
      taskId: "t1",
      taskType: "project_task",
      status: "failed",
      startedAt: "2026-11-26T09:05:00.000Z",
      actionsSummary: {},
    });

    const metrics = await store.getProjectMetrics("demo", { range: "7d", tz: "UTC", now });
    expect(metrics.days).toBe(7);
    expect(metrics.daily).toHaveLength(7);
    expect(metrics.daily[0]?.date).toBe("2026-11-20");
    expect(metrics.daily[6]?.date).toBe("2026-11-26");

    expect(metrics.summary.turnCount).toBe(2);
    expect(metrics.summary.totalTokens).toBe(9000);
    // cacheRead=5000, input=3000 -> 5000 / 8000 = 62.5%
    expect(metrics.summary.cacheHitRate).toBe(62.5);
    expect(metrics.summary.taskSuccess).toBe(1);
    expect(metrics.summary.taskFailed).toBe(1);
    expect(metrics.summary.taskSuccessRate).toBe(50);

    expect(metrics.byModel.map((m) => m.model).sort()).toEqual(["claude-sonnet-4", "gpt-5.4"]);
    expect(metrics.bySource.map((s) => s.source).sort()).toEqual(["task", "web"]);

    const day25 = metrics.daily.find((d) => d.date === "2026-11-25");
    expect(day25?.totalTokens).toBe(4500);
    expect(day25?.cacheHitRate).toBe(75);
    const day26 = metrics.daily.find((d) => d.date === "2026-11-26");
    expect(day26?.taskSuccess).toBe(1);
    expect(day26?.taskFailed).toBe(1);
  });

  test("TtlSingleflightCache deduplicates concurrent loads and respects bypassCache", async () => {
    const cache = new TtlSingleflightCache<number>();
    let calls = 0;
    const loader = async () => {
      calls += 1;
      await Bun.sleep(15);
      return calls;
    };

    const [a, b, c] = await Promise.all([
      cache.getOrLoad("k1", 5_000, loader),
      cache.getOrLoad("k1", 5_000, loader),
      cache.getOrLoad("k1", 5_000, loader),
    ]);
    expect([a, b, c]).toEqual([1, 1, 1]);
    expect(calls).toBe(1);

    const cached = await cache.getOrLoad("k1", 5_000, loader);
    expect(cached).toBe(1);
    expect(calls).toBe(1);

    const refreshed = await cache.getOrLoad("k1", 5_000, loader, { bypassCache: true });
    expect(refreshed).toBe(2);
    expect(calls).toBe(2);
  });

  test("gateway project overview & metrics routes validate params and return 404/400/200", async () => {
    const store = new MemoryStore();
    const projects = makeProjectManagerStub({
      demo: {
        tasks: [
          { taskId: "t1", enabled: true },
          { taskId: "t2", enabled: false },
        ],
      },
    });
    const router = createProjectsRouter({ projects, store });

    const notFoundRes = await router.request("/projects/missing/overview");
    expect(notFoundRes.status).toBe(404);

    const overviewRes = await router.request("/projects/demo/overview");
    expect(overviewRes.status).toBe(200);
    const overviewBody = (await overviewRes.json()) as {
      tasks: { total: number; enabled: number };
      sessions: { total: number };
    };
    expect(overviewBody.tasks).toEqual({ total: 2, enabled: 1 });
    expect(overviewBody.sessions.total).toBe(0);

    const badTzRes = await router.request("/projects/demo/metrics?range=7d&tz=Not/A_Zone");
    expect(badTzRes.status).toBe(400);

    const metricsRes = await router.request("/projects/demo/metrics?range=14d&tz=Asia/Shanghai");
    expect(metricsRes.status).toBe(200);
    const metricsBody = (await metricsRes.json()) as {
      range: string;
      days: number;
      tz: string;
      daily: unknown[];
    };
    expect(metricsBody.range).toBe("14d");
    expect(metricsBody.days).toBe(14);
    expect(metricsBody.tz).toBe("Asia/Shanghai");
    expect(metricsBody.daily).toHaveLength(14);
  });
});
