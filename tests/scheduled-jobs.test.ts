import { describe, expect, test } from "bun:test";
import {
  ScheduledJobStatus,
  type ScheduledJobRecord,
  type TurnRecord,
} from "../src/domain/types.ts";
import { Logger } from "../src/observability/logger.ts";
import { MemoryStore } from "../src/persistence/store.ts";
import { ScheduledJobs } from "../src/session/scheduled-jobs.ts";

const PROJECT_ID = "jobs";

/** Turns that complete when their session is released; until then `waitForIdle` waits. */
class HeldTurns {
  readonly submitted: Array<{ sessionId: string; input: string }> = [];
  private readonly held = new Map<string, { promise: Promise<void>; release: () => void }>();

  constructor(private readonly store: MemoryStore) {}

  hold(sessionId: string): () => void {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.held.set(sessionId, { promise, release });
    return release;
  }

  async submit(sessionId: string, input: string): Promise<TurnRecord> {
    this.submitted.push({ sessionId, input });
    const turn: TurnRecord = {
      id: `turn_${this.submitted.length}`,
      sessionId,
      input,
      status: "completed",
      createdAt: new Date().toISOString(),
    };
    await this.store.createTurn(turn);
    return turn;
  }

  async waitForIdle(sessionId: string): Promise<void> {
    await this.held.get(sessionId)?.promise;
  }
}

async function addSession(store: MemoryStore, sessionId: string): Promise<void> {
  await store.createSession({
    sessionId,
    projectId: PROJECT_ID,
    projectRuntimeId: `project-runtime:${PROJECT_ID}`,
    runtimeSessionId: null,
    configRevision: 1,
    status: "active",
    lastActiveAt: new Date().toISOString(),
  });
}

async function addJob(store: MemoryStore, jobId: string, sessionId: string): Promise<void> {
  const job: ScheduledJobRecord = {
    jobId,
    projectId: PROJECT_ID,
    sessionId,
    name: jobId,
    createdAt: new Date().toISOString(),
    delayMinutes: 1,
    triggerAt: new Date(Date.now() - 1000).toISOString(),
    status: ScheduledJobStatus.PENDING,
    prompt: `wake up for ${jobId}`,
    metadata: {},
  };
  await store.createScheduledJob(job);
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(condition()).toBe(true);
}

describe("scheduled job polling", () => {
  async function setUp() {
    const store = new MemoryStore();
    const turns = new HeldTurns(store);
    const jobs = new ScheduledJobs({
      projectId: PROJECT_ID,
      store,
      turns,
      logger: new Logger({ sink: () => {} }),
    });
    for (const id of ["ses_slow", "ses_fast"]) await addSession(store, id);
    await addJob(store, "job_slow", "ses_slow");
    await addJob(store, "job_fast", "ses_fast");
    return { store, turns, jobs };
  }

  test("a long turn in one session does not hold up another session's job", async () => {
    const { store, turns, jobs } = await setUp();
    const release = turns.hold("ses_slow");
    const polled = jobs.poll();
    await until(() => store.scheduledJobs.get("job_fast")?.status === ScheduledJobStatus.COMPLETED);
    expect(store.scheduledJobs.get("job_slow")?.status).toBe(ScheduledJobStatus.RUNNING);
    release();
    await polled;
    expect(store.scheduledJobs.get("job_slow")?.status).toBe(ScheduledJobStatus.COMPLETED);
  });

  test("overlapping polls run each job once", async () => {
    const { turns, jobs } = await setUp();
    const release = turns.hold("ses_slow");
    const first = jobs.poll();
    await until(() => turns.submitted.length > 0);
    const second = jobs.poll();
    release();
    await Promise.all([first, second]);
    expect(turns.submitted.map((turn) => turn.sessionId).sort()).toEqual(["ses_fast", "ses_slow"]);
  });

  test("stop waits for the jobs that are running", async () => {
    const { store, turns, jobs } = await setUp();
    const release = turns.hold("ses_slow");
    void jobs.poll();
    await until(() => turns.submitted.length === 2);
    let stopped = false;
    const stopping = jobs.stop().then(() => {
      stopped = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(store.scheduledJobs.get("job_slow")?.status).toBe(ScheduledJobStatus.COMPLETED);
  });
});
