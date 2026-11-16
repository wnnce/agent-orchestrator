import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryStore } from "../src/persistence/store.ts";
import {
  ActionRegistry,
  createActionContext,
  defaultActionRegistry,
} from "../src/actions/index.ts";
import {
  ScheduledJobStatus,
  type ProjectConfig,
  type SessionRoute,
  type TurnRecord,
} from "../src/domain/types.ts";
import { ProjectRuntime } from "../src/project/runtime.ts";
import { FakeRuntime } from "../src/runtime/runtime.ts";
import { WorkspaceManager } from "../src/workspace/workspace.ts";
import { ArtifactStore } from "../src/artifacts/store.ts";

async function createLocalGitRepo(repoDir: string): Promise<void> {
  await mkdir(repoDir, { recursive: true });
  for (const args of [
    ["init", "--initial-branch=main"],
    ["config", "user.name", "test"],
    ["config", "user.email", "test@test.com"],
    ["commit", "--allow-empty", "-m", "initial"],
  ]) {
    const process = Bun.spawn(["git", ...args], { cwd: repoDir, stdout: "ignore", stderr: "pipe" });
    if ((await process.exited) !== 0) throw new Error(await new Response(process.stderr).text());
  }
}

describe("Session-Only Delayed Trigger / ScheduledJob (Minute-Level Delayed Queue)", () => {
  let tempRoot: string;
  let localRepo: string;
  let dummyProject: ProjectConfig;

  beforeAll(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "session-job-test-"));
    localRepo = path.join(tempRoot, "repo.git");
    await createLocalGitRepo(localRepo);
    dummyProject = {
      id: "proj_delay",
      displayName: "Delayed Trigger Project",
      description: "Project for delayed triggers",
      routing: {
        projectId: "proj_delay",
        displayName: "Delayed Trigger Project",
      },
      repositories: [{ id: "main", url: localRepo, isPrimary: true, baseBranch: "main" }],
    };
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("Action scope isolation: schedule_job and cancel_job are available only in conversation, not in task", () => {
    const convActions = defaultActionRegistry.list("conversation").map((a) => a.name);
    const taskActions = defaultActionRegistry.list("task").map((a) => a.name);

    expect(convActions).toContain("schedule_job");
    expect(convActions).toContain("cancel_job");

    expect(taskActions).not.toContain("schedule_job");
    expect(taskActions).not.toContain("cancel_job");
  });

  test("schedule_job enqueues job with monotonic integer status 1 (PENDING) and records createdTurnId", async () => {
    const store = new MemoryStore();
    const ctx = createActionContext({
      projectId: "proj_delay",
      sessionId: "ses_001",
      turnId: "turn_init_1",
      services: { store },
    });

    const result = await defaultActionRegistry.execute<{
      jobId: string;
      name: string;
      delayMinutes: number;
      triggerAt: string;
    }>(
      "schedule_job",
      {
        name: "check_pipeline",
        delay_minutes: 10,
        prompt: "10分钟已到，请检查构建结果",
        metadata: { buildId: "b_123" },
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.data?.name).toBe("check_pipeline");
    expect(result.data?.delayMinutes).toBe(10);

    // Verify persisted job record
    const dueJobs = await store.listDueScheduledJobs(
      "proj_delay",
      new Date(Date.now() + 11 * 60_000),
    );
    expect(dueJobs.length).toBe(1);
    const job = dueJobs[0]!;
    expect(job.name).toBe("check_pipeline");
    expect(job.status).toBe(ScheduledJobStatus.PENDING); // 1
    expect(job.delayMinutes).toBe(10);
    expect(job.prompt).toBe("10分钟已到，请检查构建结果");
    expect(job.metadata.buildId).toBe("b_123");
    expect(job.metadata.createdTurnId).toBe("turn_init_1");
  });

  test("cancel_job transitions pending job to status 3 (CANCELLED)", async () => {
    const store = new MemoryStore();
    const ctx = createActionContext({
      projectId: "proj_delay",
      sessionId: "ses_cancel",
      services: { store },
    });

    await defaultActionRegistry.execute(
      "schedule_job",
      {
        name: "remind_review",
        delay_minutes: 5,
        prompt: "请复查代码",
      },
      ctx,
    );

    // Cancel job actively
    const cancelRes = await defaultActionRegistry.execute<{ success: boolean; name: string }>(
      "cancel_job",
      { name: "remind_review" },
      ctx,
    );

    expect(cancelRes.success).toBe(true);
    expect(cancelRes.data?.success).toBe(true);

    // After cancellation, scan for due jobs should return empty (status is now CANCELLED)
    const due = await store.listDueScheduledJobs("proj_delay", new Date(Date.now() + 10 * 60_000));
    expect(due.length).toBe(0);

    // Verify stored state is CANCELLED (3)
    const all = [...store.scheduledJobs.values()];
    expect(all[0]?.status).toBe(ScheduledJobStatus.CANCELLED);
  });

  test("pollScheduledJobs triggers turn when due and transitions to status 0 (COMPLETED) upon turn finish", async () => {
    const store = new MemoryStore();
    const runtime = new FakeRuntime();
    const workspaces = new WorkspaceManager(
      path.join(tempRoot, "ws_test_jobs"),
      path.join(tempRoot, "bases_test_jobs"),
    );
    const artifacts = new ArtifactStore(path.join(tempRoot, "art_test_jobs"), store);

    const projectRuntime = new ProjectRuntime(
      dummyProject,
      store,
      runtime,
      workspaces,
      artifacts,
    );

    // 1. Create active session
    const sessionRoute = await projectRuntime.createSession();
    const sessionId = sessionRoute.sessionId;

    // 2. Initial turn
    const turn1 = await projectRuntime.turn(sessionId, "帮我准备测试环境");
    await projectRuntime.waitForIdle(sessionId);

    // 3. Schedule delayed job (10 minutes)
    const triggerAt = new Date(Date.now() + 10 * 60_000).toISOString();
    await store.createScheduledJob({
      jobId: "job_success_test",
      projectId: dummyProject.id,
      sessionId,
      name: "delayed_check",
      createdAt: new Date().toISOString(),
      delayMinutes: 10,
      triggerAt,
      status: ScheduledJobStatus.PENDING,
      prompt: "定时唤醒：环境是否就绪？",
      metadata: { createdTurnId: turn1.id },
    });

    // 4. Poll when due (now + 11m)
    const asOf = new Date(Date.now() + 11 * 60_000);
    await projectRuntime.pollScheduledJobs(asOf);

    // 5. Verify status transitioned to COMPLETED (0)
    const finishedJob = store.scheduledJobs.get("job_success_test");
    expect(finishedJob?.status).toBe(ScheduledJobStatus.COMPLETED); // 0
    expect(finishedJob?.resultSummary).toBe("completed");
    expect(finishedJob?.finishedAt).toBeDefined();

    // Verify automatically injected turn in session
    const latestTurn = await store.getLatestTurn(sessionId);
    expect(latestTurn?.input).toBe("定时唤醒：环境是否就绪？");

    await projectRuntime.stop();
  });

  test("Defense 1: pollScheduledJobs abandons job (status 4) if session has been closed or archived", async () => {
    const store = new MemoryStore();
    const runtime = new FakeRuntime();
    const workspaces = new WorkspaceManager(
      path.join(tempRoot, "ws_test_jobs2"),
      path.join(tempRoot, "bases_test_jobs2"),
    );
    const artifacts = new ArtifactStore(path.join(tempRoot, "art_test_jobs2"), store);

    const projectRuntime = new ProjectRuntime(
      dummyProject,
      store,
      runtime,
      workspaces,
      artifacts,
    );

    const sessionRoute = await projectRuntime.createSession();
    const sessionId = sessionRoute.sessionId;

    // Create scheduled job
    await store.createScheduledJob({
      jobId: "job_abandon_close",
      projectId: dummyProject.id,
      sessionId,
      name: "abandon_check",
      createdAt: new Date().toISOString(),
      delayMinutes: 10,
      triggerAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      status: ScheduledJobStatus.PENDING,
      prompt: "唤醒测试",
      metadata: {},
    });

    // Active session cleanup
    await projectRuntime.cleanupSession(sessionId);

    // Poll when due
    const asOf = new Date(Date.now() + 15 * 60_000);
    await projectRuntime.pollScheduledJobs(asOf);

    // Verify job abandoned with reason session_closed
    const job = store.scheduledJobs.get("job_abandon_close");
    expect(job?.status).toBe(ScheduledJobStatus.ABANDONED); // 4
    expect(job?.resultSummary).toBe("session_closed");

    await projectRuntime.stop();
  });

  test("Defense 2: pollScheduledJobs abandons job (status 4) if session progressed with a newer turn", async () => {
    const store = new MemoryStore();
    const runtime = new FakeRuntime();
    const workspaces = new WorkspaceManager(
      path.join(tempRoot, "ws_test_jobs3"),
      path.join(tempRoot, "bases_test_jobs3"),
    );
    const artifacts = new ArtifactStore(path.join(tempRoot, "art_test_jobs3"), store);

    const projectRuntime = new ProjectRuntime(
      dummyProject,
      store,
      runtime,
      workspaces,
      artifacts,
    );

    const sessionRoute = await projectRuntime.createSession();
    const sessionId = sessionRoute.sessionId;

    // Turn 1
    const turn1 = await projectRuntime.turn(sessionId, "第一轮对话");
    await projectRuntime.waitForIdle(sessionId);

    // Schedule 10 minute reminder during Turn 1
    await store.createScheduledJob({
      jobId: "job_stale_turn",
      projectId: dummyProject.id,
      sessionId,
      name: "stale_check",
      createdAt: new Date().toISOString(),
      delayMinutes: 10,
      triggerAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      status: ScheduledJobStatus.PENDING,
      prompt: "旧提醒：还记得刚才的事吗？",
      metadata: { createdTurnId: turn1.id }, // Bound to turn 1
    });

    // User sends Turn 2 before timer expires
    const turn2 = await projectRuntime.turn(sessionId, "第二轮新指令：别管刚才的事了，先看这个新需求");
    await projectRuntime.waitForIdle(sessionId);

    // Poll 10 minutes later
    const asOf = new Date(Date.now() + 15 * 60_000);
    await projectRuntime.pollScheduledJobs(asOf);

    // Verify stale reminder is marked ABANDONED (4)
    const job = store.scheduledJobs.get("job_stale_turn");
    expect(job?.status).toBe(ScheduledJobStatus.ABANDONED); // 4
    expect(job?.resultSummary).toBe("stale_turn_superceded");

    // Stale reminder prompt should not be injected into session
    const latestTurn = await store.getLatestTurn(sessionId);
    expect(latestTurn?.id).toBe(turn2.id);

    await projectRuntime.stop();
  });

  test("session lifecycle defers archive while a delayed job is pending", async () => {
    const store = new MemoryStore();
    const runtime = new FakeRuntime();
    const workspaces = new WorkspaceManager(
      path.join(tempRoot, "ws_test_jobs4"),
      path.join(tempRoot, "bases_test_jobs4"),
    );
    const artifacts = new ArtifactStore(path.join(tempRoot, "art_test_jobs4"), store);
    const projectRuntime = new ProjectRuntime(dummyProject, store, runtime, workspaces, artifacts);

    const sessionRoute = await projectRuntime.createSession();
    const sessionId = sessionRoute.sessionId;
    const triggerAt = new Date(Date.now() + 10 * 60_000).toISOString();
    await store.createScheduledJob({
      jobId: "job_pending_keepalive",
      projectId: dummyProject.id,
      sessionId,
      name: "pending_keepalive",
      createdAt: new Date().toISOString(),
      delayMinutes: 10,
      triggerAt,
      status: ScheduledJobStatus.PENDING,
      prompt: "延时任务仍应唤醒会话",
      metadata: {},
    });

    const entity = projectRuntime.sessionManager.get(sessionId)!;
    entity.touch(new Date(Date.now() - 2 * 60 * 60_000).toISOString());
    await projectRuntime.sessionManager.save(sessionId);

    await projectRuntime.checkLifecycles();

    expect((await store.getSession(sessionId))?.status).toBe("suspended");
    expect(store.scheduledJobs.get("job_pending_keepalive")?.status).toBe(
      ScheduledJobStatus.PENDING,
    );

    await projectRuntime.pollScheduledJobs(new Date(Date.now() + 11 * 60_000));
    expect(store.scheduledJobs.get("job_pending_keepalive")?.status).toBe(
      ScheduledJobStatus.COMPLETED,
    );
    expect((await store.getLatestTurn(sessionId))?.input).toBe("延时任务仍应唤醒会话");

    await projectRuntime.stop();
  });

  test("session lifecycle archives an idle session when no delayed job is pending", async () => {
    const store = new MemoryStore();
    const runtime = new FakeRuntime();
    const workspaces = new WorkspaceManager(
      path.join(tempRoot, "ws_test_jobs5"),
      path.join(tempRoot, "bases_test_jobs5"),
    );
    const artifacts = new ArtifactStore(path.join(tempRoot, "art_test_jobs5"), store);
    const projectRuntime = new ProjectRuntime(dummyProject, store, runtime, workspaces, artifacts);

    const sessionRoute = await projectRuntime.createSession();
    const sessionId = sessionRoute.sessionId;
    const entity = projectRuntime.sessionManager.get(sessionId)!;
    entity.touch(new Date(Date.now() - 2 * 60 * 60_000).toISOString());
    await projectRuntime.sessionManager.save(sessionId);

    await projectRuntime.checkLifecycles();

    expect((await store.getSession(sessionId))?.status).toBe("archived");

    await projectRuntime.stop();
  });

  test("session lifecycle archives after the pending delayed job completes", async () => {
    const store = new MemoryStore();
    const runtime = new FakeRuntime();
    const workspaces = new WorkspaceManager(
      path.join(tempRoot, "ws_test_jobs6"),
      path.join(tempRoot, "bases_test_jobs6"),
    );
    const artifacts = new ArtifactStore(path.join(tempRoot, "art_test_jobs6"), store);
    const projectRuntime = new ProjectRuntime(dummyProject, store, runtime, workspaces, artifacts);

    const sessionRoute = await projectRuntime.createSession();
    const sessionId = sessionRoute.sessionId;
    const staleAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    await store.createScheduledJob({
      jobId: "job_completed_cleanup",
      projectId: dummyProject.id,
      sessionId,
      name: "completed_cleanup",
      createdAt: new Date().toISOString(),
      delayMinutes: 10,
      triggerAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      status: ScheduledJobStatus.PENDING,
      prompt: "完成后恢复正常清理",
      metadata: {},
    });

    const entity = projectRuntime.sessionManager.get(sessionId)!;
    entity.touch(staleAt);
    await projectRuntime.sessionManager.save(sessionId);
    await projectRuntime.checkLifecycles();
    expect((await store.getSession(sessionId))?.status).toBe("suspended");

    await projectRuntime.pollScheduledJobs(new Date(Date.now() + 11 * 60_000));
    expect(store.scheduledJobs.get("job_completed_cleanup")?.status).toBe(
      ScheduledJobStatus.COMPLETED,
    );

    entity.touch(staleAt);
    await projectRuntime.sessionManager.save(sessionId);
    await projectRuntime.checkLifecycles();
    expect((await store.getSession(sessionId))?.status).toBe("archived");

    await projectRuntime.stop();
  });

  test("session lifecycle archives after the pending delayed job is cancelled", async () => {
    const store = new MemoryStore();
    const runtime = new FakeRuntime();
    const workspaces = new WorkspaceManager(
      path.join(tempRoot, "ws_test_jobs7"),
      path.join(tempRoot, "bases_test_jobs7"),
    );
    const artifacts = new ArtifactStore(path.join(tempRoot, "art_test_jobs7"), store);
    const projectRuntime = new ProjectRuntime(dummyProject, store, runtime, workspaces, artifacts);

    const sessionRoute = await projectRuntime.createSession();
    const sessionId = sessionRoute.sessionId;
    const staleAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    await store.createScheduledJob({
      jobId: "job_cancelled_cleanup",
      projectId: dummyProject.id,
      sessionId,
      name: "cancelled_cleanup",
      createdAt: new Date().toISOString(),
      delayMinutes: 10,
      triggerAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      status: ScheduledJobStatus.PENDING,
      prompt: "取消后恢复正常清理",
      metadata: {},
    });

    const entity = projectRuntime.sessionManager.get(sessionId)!;
    entity.touch(staleAt);
    await projectRuntime.sessionManager.save(sessionId);
    await projectRuntime.checkLifecycles();
    expect((await store.getSession(sessionId))?.status).toBe("suspended");

    expect(await store.cancelScheduledJob(sessionId, "cancelled_cleanup")).toBe(true);
    entity.touch(staleAt);
    await projectRuntime.sessionManager.save(sessionId);
    await projectRuntime.checkLifecycles();
    expect((await store.getSession(sessionId))?.status).toBe("archived");

    await projectRuntime.stop();
  });
});
