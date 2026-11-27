import { describe, expect, it } from "bun:test";
import { Gateway } from "../src/gateway/server.ts";
import { MemoryStore } from "../src/persistence/store.ts";
import { ProjectManager } from "../src/project/manager.ts";
import { Logger } from "../src/observability/logger.ts";
import type { AppConfig } from "../src/config/config.ts";
import type { ProjectConfig } from "../src/domain/types.ts";

const sampleProject: ProjectConfig = {
  id: "test-proj",
  displayName: "Test Project",
  description: "Test Project Description",
  routing: {
    projectId: "test-proj",
    displayName: "Test Project",
    summary: "Test Summary",
    keywords: ["test", "sample"],
  },
  runtime: {
    type: "fake",
  },
  repository: { url: "", baseBranch: "main" },
};

function createTestGateway(customConfig?: Partial<AppConfig>) {
  const config: AppConfig = {
    port: 7070,
    host: "127.0.0.1",
    dataDir: "/tmp/gateway-test-data",
    artifactDir: "/tmp/gateway-test-artifacts",
    projectConfigPath: "/tmp/gateway-test-projects",
    allowUnauthenticated: true,
    routerModel: "gpt-4o",
    routerBaseUrl: "http://localhost:8317/v1",
    logLevel: "info",
    feishu: { enabled: false },
    ...customConfig,
  };
  const store = new MemoryStore();
  const logger = new Logger();
  const projectManager = new ProjectManager([sampleProject], store, config, logger);
  const gateway = new Gateway(config, store, projectManager, logger);
  return { gateway, projectManager, store };
}

describe("Gateway with Hono", () => {
  it("responds to /healthz and /readyz", async () => {
    const { gateway } = createTestGateway();
    const resHealth = await gateway.handle(new Request("http://localhost/healthz"));
    expect(resHealth.status).toBe(200);
    expect(await resHealth.json()).toEqual({ status: "ok" });

    const resReady = await gateway.handle(new Request("http://localhost/readyz"));
    expect(resReady.status).toBe(200);
    expect(await resReady.json()).toEqual({ status: "ready" });
  });

  it("lists projects via GET /api/v1/projects", async () => {
    const { gateway } = createTestGateway();
    const res = await gateway.handle(new Request("http://localhost/api/v1/projects"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0].projectId).toBe("test-proj");
  });

  it("enforces authentication when configured", async () => {
    const { gateway } = createTestGateway({
      allowUnauthenticated: false,
      apiToken: "super-secret-token",
    });

    // Unauthenticated request should be rejected
    const unauthRes = await gateway.handle(new Request("http://localhost/api/v1/projects"));
    expect(unauthRes.status).toBe(401);
    expect(await unauthRes.json()).toEqual({
      error: "unauthorized",
      message: "Missing or invalid Bearer API token",
    });

    // Authenticated request should succeed
    const authRes = await gateway.handle(
      new Request("http://localhost/api/v1/projects", {
        headers: { authorization: "Bearer super-secret-token" },
      }),
    );
    expect(authRes.status).toBe(200);
  });

  it("creates session, executes turns, and retrieves session & events", async () => {
    const { gateway, projectManager } = createTestGateway();
    await projectManager.start();

    try {
      // Create session
      const createRes = await gateway.handle(
        new Request("http://localhost/api/v1/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projectId: "test-proj",
            query: "Hello from Hono gateway test!",
          }),
        }),
      );
      expect(createRes.status).toBe(201);
      const createBody = (await createRes.json()) as any;
      const sessionId = createBody.session.sessionId;
      expect(sessionId).toBeDefined();
      expect(createBody.routedProject).toBe("test-proj");

      // Retrieve session details
      const getSessionRes = await gateway.handle(
        new Request(`http://localhost/api/v1/sessions/${sessionId}`),
      );
      expect(getSessionRes.status).toBe(200);
      const sessionBody = (await getSessionRes.json()) as any;
      expect(sessionBody.session.sessionId).toBe(sessionId);

      // Post another turn
      const turnRes = await gateway.handle(
        new Request(`http://localhost/api/v1/sessions/${sessionId}/turns`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input: "Second turn input" }),
        }),
      );
      expect(turnRes.status).toBe(202);

      // Check events as JSON
      const eventsRes = await gateway.handle(
        new Request(`http://localhost/api/v1/sessions/${sessionId}/events`),
      );
      expect(eventsRes.status).toBe(200);
      const eventsBody = (await eventsRes.json()) as any;
      expect(Array.isArray(eventsBody.events)).toBe(true);
      expect(eventsBody.events.length).toBeGreaterThan(0);

      // Rename session via PATCH
      const patchRes = await gateway.handle(
        new Request(`http://localhost/api/v1/sessions/${sessionId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "修改后的标题" }),
        }),
      );
      expect(patchRes.status).toBe(200);
      const patchBody = (await patchRes.json()) as any;
      expect(patchBody.title).toBe("修改后的标题");

      // Verify title updated
      const getRenamedRes = await gateway.handle(
        new Request(`http://localhost/api/v1/sessions/${sessionId}`),
      );
      const renamedBody = (await getRenamedRes.json()) as any;
      expect(renamedBody.session.title).toBe("修改后的标题");

      // Create session with explicit title directly
      const explicitTitleRes = await gateway.handle(
        new Request("http://localhost/api/v1/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projectId: "test-proj",
            title: "Explicit Title On Creation",
            query: "Do something with title",
          }),
        }),
      );
      expect(explicitTitleRes.status).toBe(201);
      const explicitTitleBody = (await explicitTitleRes.json()) as any;
      expect(explicitTitleBody.session.title).toBe("Explicit Title On Creation");

      // Check GET /api/v1/sessions hides scheduled-task sessions but lists dispatched ones
      const projectRuntime = projectManager.get("test-proj");
      const taskSession = await projectRuntime.createSession(
        { taskKey: "test-proj:cron-test" },
        "task",
      );
      const dispatchedSession = await projectRuntime.createSession(
        { sourceSessionId: sessionId, dispatch: { taskKey: "spoofed" } },
        "dispatch",
      );
      const listSessionsRes = await gateway.handle(
        new Request("http://localhost/api/v1/sessions?projectId=test-proj"),
      );
      expect(listSessionsRes.status).toBe(200);
      const listSessionsBody = (await listSessionsRes.json()) as any;
      const returnedIds = listSessionsBody.sessions.map((s: any) => s.sessionId);
      expect(returnedIds).toContain(sessionId);
      expect(returnedIds).toContain(explicitTitleBody.session.sessionId);
      expect(returnedIds).not.toContain(taskSession.sessionId);
      expect(returnedIds).toContain(dispatchedSession.sessionId);

      // Delete session
      const deleteRes = await gateway.handle(
        new Request(`http://localhost/api/v1/sessions/${sessionId}`, { method: "DELETE" }),
      );
      expect(deleteRes.status).toBe(200);
      const deleteBody = (await deleteRes.json()) as any;
      expect(deleteBody.status).toBe("deleted");
      expect(deleteBody.sessionId).toBe(sessionId);

      // Session should now return 404
      const getDeletedRes = await gateway.handle(
        new Request(`http://localhost/api/v1/sessions/${sessionId}`),
      );
      expect(getDeletedRes.status).toBe(404);
    } finally {
      await projectManager.stop();
    }
  });

  it("returns 404 for non-existent session or route", async () => {
    const { gateway } = createTestGateway();
    const notFoundRes = await gateway.handle(
      new Request("http://localhost/api/v1/sessions/ses_non_existent"),
    );
    expect(notFoundRes.status).toBe(404);

    const unknownRes = await gateway.handle(
      new Request("http://localhost/unknown_route", { method: "POST" }),
    );
    expect(unknownRes.status).toBe(404);
  });

  it("streams events via text/event-stream using EventHub", async () => {
    const { gateway, projectManager } = createTestGateway();
    await projectManager.start();

    try {
      const createRes = await gateway.handle(
        new Request("http://localhost/api/v1/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId: "test-proj", query: "Initial query" }),
        }),
      );
      const { session } = (await createRes.json()) as any;

      const sseRes = await gateway.handle(
        new Request(`http://localhost/api/v1/sessions/${session.sessionId}/events`, {
          headers: { accept: "text/event-stream" },
        }),
      );
      expect(sseRes.status).toBe(200);
      expect(sseRes.headers.get("content-type")).toContain("text/event-stream");

      const reader = sseRes.body?.getReader();
      expect(reader).toBeDefined();

      const { value } = await reader!.read();
      const text = new TextDecoder().decode(value);
      expect(text).toContain("data:");
      await reader!.cancel();
    } finally {
      await projectManager.stop();
    }
  });

  it("resumes SSE by source and lets an explicit after override the saved cursor", async () => {
    const { gateway, projectManager, store } = createTestGateway();
    await projectManager.start();
    try {
      const session = await projectManager.get("test-proj").createSession();
      for (const sequence of [2, 3]) {
        await store.appendEvent({
          id: `source-event-${sequence}`,
          projectId: session.projectId,
          sessionId: session.sessionId,
          sequence,
          type: "agent.message.delta",
          runtime: "fake",
          payload: { text: `message-${sequence}` },
          createdAt: new Date().toISOString(),
          schemaVersion: 1,
        });
      }
      const entity = projectManager.sessionManager.get(session.sessionId)!;
      entity.ack("console", 2);
      entity.ack("feishu", 1);
      const response = await gateway.handle(
        new Request(`http://localhost/api/v1/sessions/${session.sessionId}/events?source=console`, {
          headers: { accept: "text/event-stream" },
        }),
      );
      const reader = response.body!.getReader();
      try {
        const chunk = new TextDecoder().decode((await reader.read()).value);
        expect(chunk).toContain("id: 3");
        expect(entity.getCursor("console")).toBe(3);
        expect(entity.getCursor("feishu")).toBe(1);
      } finally {
        await reader.cancel();
      }
      const replay = await gateway.handle(
        new Request(
          `http://localhost/api/v1/sessions/${session.sessionId}/events?source=console&after=0`,
          {
            headers: { accept: "text/event-stream" },
          },
        ),
      );
      const replayReader = replay.body!.getReader();
      try {
        const chunk = new TextDecoder().decode((await replayReader.read()).value);
        expect(chunk).toContain("id: 1");
      } finally {
        await replayReader.cancel();
      }
    } finally {
      await gateway.stop();
      await projectManager.stop();
    }
  });

  it("releases failed inbound claims so the same message can be retried", async () => {
    const { gateway, projectManager, store } = createTestGateway();
    await projectManager.start();
    try {
      const project = projectManager.get("test-proj");
      const turn = project.turn.bind(project);
      let attempts = 0;
      project.turn = async (sessionId, input) => {
        if (++attempts === 1) throw new Error("temporary admission failure");
        return turn(sessionId, input);
      };
      const request = () =>
        new Request("http://localhost/api/v1/webhooks/test-proj", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            messageId: "retry-message",
            conversationId: "retry-chat",
            input: "test",
          }),
        });
      expect((await gateway.handle(request())).status).toBe(500);
      expect(store.inboundMessages.has("retry-message")).toBe(false);
      const retry = await gateway.handle(request());
      expect(retry.status).toBe(202);
      expect(attempts).toBe(2);
      expect(store.inboundMessages.has("retry-message")).toBe(true);
      const duplicate = await gateway.handle(request());
      expect(duplicate.status).toBe(202);
      expect(((await duplicate.json()) as any).duplicate).toBe(true);
      expect(attempts).toBe(2);
    } finally {
      await gateway.stop();
      await projectManager.stop();
    }
  });

  it("refuses manual turns in task sessions from both the session API and webhooks", async () => {
    const { gateway, projectManager } = createTestGateway();
    await projectManager.start();
    try {
      const session = await projectManager.get("test-proj").createSession(undefined, "task");
      const viaSessionApi = await gateway.handle(
        new Request(`http://localhost/api/v1/sessions/${session.sessionId}/turns`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input: "hi" }),
        }),
      );
      const viaWebhook = await gateway.handle(
        new Request("http://localhost/api/v1/webhooks/test-proj", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: session.sessionId, input: "hi" }),
        }),
      );
      for (const response of [viaSessionApi, viaWebhook]) {
        expect(response.status).toBe(403);
        expect(((await response.json()) as { error: string }).error).toBe("task_session_read_only");
      }
    } finally {
      await gateway.stop();
      await projectManager.stop();
    }
  });

  it("lists tool executions via GET /api/v1/tool-executions", async () => {
    const { gateway, store } = createTestGateway();

    await store.recordToolExecution({
      executionId: "tex_test_gw_1",
      projectId: "test-proj",
      sessionId: "ses_gw_1",
      ownerKind: "task",
      ownerId: "exec_1",
      toolName: "send_notification",
      parameters: { title: "Test Alert" },
      status: "success",
      result: { sent: 1 },
      durationMs: 42,
    });

    const res = await gateway.handle(
      new Request("http://localhost/api/v1/tool-executions?projectId=test-proj&ownerKind=task"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.executions).toHaveLength(1);
    expect(body.executions[0].executionId).toBe("tex_test_gw_1");
    expect(body.executions[0].toolName).toBe("send_notification");
    expect(body.executions[0].ownerId).toBe("exec_1");
    expect(body.executions[0].durationMs).toBe(42);
  });

  it("returns 404 JSON for unknown /api/* routes instead of falling back to SPA HTML", async () => {
    const { gateway } = createTestGateway();
    const res = await gateway.handle(new Request("http://localhost/api/v1/nonexistent-endpoint"));
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});
