import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { SessionService } from "../src/app/sessions.ts";
import { SessionTitleGenerator } from "../src/app/titles.ts";
import type { AppConfig } from "../src/config/config.ts";
import { ErrorCode, ForbiddenError, NotFoundError } from "../src/domain/errors.ts";
import type { ProjectConfig } from "../src/domain/types.ts";
import { Logger } from "../src/observability/logger.ts";
import { MemoryStore } from "../src/persistence/store.ts";
import { ProjectManager } from "../src/project/manager.ts";
import { ProjectRouter } from "../src/router/project-router.ts";

const project: ProjectConfig = {
  id: "svc-proj",
  displayName: "Service Project",
  description: "",
  routing: { projectId: "svc-proj", displayName: "Service Project", summary: "", keywords: [] },
  runtime: { type: "fake" },
  repository: { url: "", baseBranch: "main" },
};

const config = {
  dataDir: "/tmp/session-service-test-data",
  artifactDir: "/tmp/session-service-test-artifacts",
} as AppConfig;

describe("SessionService", () => {
  const logger = new Logger({ level: "error" });
  const store = new MemoryStore();
  const projects = new ProjectManager([project], store, config, logger);
  const sessions = new SessionService({
    projects,
    router: new ProjectRouter(),
    titles: new SessionTitleGenerator(undefined, logger),
    logger,
  });
  beforeAll(() => projects.start());
  afterAll(() => projects.stop());

  it("opens a session in the given project, binds it and submits the query", async () => {
    const created = await sessions.create({
      projectId: project.id,
      query: "hello there",
      external: { channel: "http", conversationId: "conv-1" },
    });
    expect(created.routedProject).toBe(project.id);
    expect(created.session.source).toBe("http");
    expect(created.turn?.input).toBe("hello there");
    const bound = await store.findSessionByExternal("http", "conv-1");
    expect(bound?.sessionId).toBe(created.session.sessionId);
  });

  it("names an untitled session after the first message", async () => {
    const created = await sessions.create({ projectId: project.id });
    await sessions.submitTurn(created.session.sessionId, "Fix the login bug");
    await projects.get(project.id).waitForIdle(created.session.sessionId);
    await Bun.sleep(10);
    expect((await store.getSession(created.session.sessionId))?.title).toBe("Fix the login bug");
  });

  it("refuses turns from people in task sessions", async () => {
    const session = await projects.get(project.id).createSession(undefined, "task");
    const submit = sessions.submitTurn(session.sessionId, "please stop");
    await expect(submit).rejects.toBeInstanceOf(ForbiddenError);
    await expect(submit).rejects.toMatchObject({ code: ErrorCode.TASK_SESSION_READ_ONLY });
  });

  it("reports unknown sessions as not found", async () => {
    await expect(sessions.submitTurn("ses_missing", "hi")).rejects.toBeInstanceOf(NotFoundError);
  });
});
