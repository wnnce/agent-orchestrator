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
    repositories: ["sample/repo"],
    keywords: ["test", "sample"],
  },
  agent: {
    type: "fake",
  },
  repositories: [
    {
      id: "main",
      url: "",
      baseBranch: "main",
      isPrimary: true,
    },
  ],
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
    codex: {},
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

  it("lists projects via GET /projects", async () => {
    const { gateway } = createTestGateway();
    const res = await gateway.handle(new Request("http://localhost/projects"));
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
    const unauthRes = await gateway.handle(new Request("http://localhost/projects"));
    expect(unauthRes.status).toBe(401);
    expect(await unauthRes.json()).toEqual({ error: "unauthorized" });

    // Authenticated request should succeed
    const authRes = await gateway.handle(
      new Request("http://localhost/projects", {
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
        new Request("http://localhost/sessions", {
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
        new Request(`http://localhost/sessions/${sessionId}`),
      );
      expect(getSessionRes.status).toBe(200);
      const sessionBody = (await getSessionRes.json()) as any;
      expect(sessionBody.session.sessionId).toBe(sessionId);

      // Post another turn
      const turnRes = await gateway.handle(
        new Request(`http://localhost/sessions/${sessionId}/turns`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input: "Second turn input" }),
        }),
      );
      expect(turnRes.status).toBe(202);

      // Check events as JSON
      const eventsRes = await gateway.handle(
        new Request(`http://localhost/sessions/${sessionId}/events`),
      );
      expect(eventsRes.status).toBe(200);
      const eventsBody = (await eventsRes.json()) as any;
      expect(Array.isArray(eventsBody.events)).toBe(true);
      expect(eventsBody.events.length).toBeGreaterThan(0);

      // Rename session via PATCH
      const patchRes = await gateway.handle(
        new Request(`http://localhost/sessions/${sessionId}`, {
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
        new Request(`http://localhost/sessions/${sessionId}`),
      );
      const renamedBody = (await getRenamedRes.json()) as any;
      expect(renamedBody.session.title).toBe("修改后的标题");

      // Create session with explicit title directly
      const explicitTitleRes = await gateway.handle(
        new Request("http://localhost/sessions", {
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

      // Check GET /sessions hides scheduled-task sessions but lists dispatched ones
      const projectRuntime = projectManager.get("test-proj");
      const taskSession = await projectRuntime.createSession(
        undefined,
        { taskKey: "test-proj:cron-test" },
        "task",
      );
      const dispatchedSession = await projectRuntime.createSession(
        undefined,
        { sourceSessionId: sessionId, dispatch: { taskKey: "spoofed" } },
        "dispatch",
      );
      const listSessionsRes = await gateway.handle(
        new Request("http://localhost/sessions?projectId=test-proj"),
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
        new Request(`http://localhost/sessions/${sessionId}`, { method: "DELETE" }),
      );
      expect(deleteRes.status).toBe(200);
      const deleteBody = (await deleteRes.json()) as any;
      expect(deleteBody.status).toBe("deleted");
      expect(deleteBody.sessionId).toBe(sessionId);

      // Session should now return 404
      const getDeletedRes = await gateway.handle(
        new Request(`http://localhost/sessions/${sessionId}`),
      );
      expect(getDeletedRes.status).toBe(404);
    } finally {
      await projectManager.stop();
    }
  });

  it("returns 404 for non-existent session or route", async () => {
    const { gateway } = createTestGateway();
    const notFoundRes = await gateway.handle(
      new Request("http://localhost/sessions/ses_non_existent"),
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
        new Request("http://localhost/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId: "test-proj", query: "Initial query" }),
        }),
      );
      const { session } = (await createRes.json()) as any;

      const sseRes = await gateway.handle(
        new Request(`http://localhost/sessions/${session.sessionId}/events`, {
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
        new Request(`http://localhost/sessions/${session.sessionId}/events?source=console`, {
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
          `http://localhost/sessions/${session.sessionId}/events?source=console&after=0`,
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
        new Request("http://localhost/webhooks/test-proj", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            messageId: "retry-message",
            conversationId: "retry-chat",
            input: "test",
          }),
        });
      expect((await gateway.handle(request())).status).toBe(400);
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

  it("accepts a Feishu event through the transport-neutral ingress", async () => {
    const { gateway, projectManager, store } = createTestGateway({
      feishu: { enabled: true, verificationToken: "verify-token" },
    });
    await projectManager.start();
    try {
      const response = await gateway.handle(
        new Request("http://localhost/channels/feishu/events", {
          method: "POST",
          body: JSON.stringify({
            header: {
              event_id: "evt-feishu-1",
              event_type: "im.message.receive_v1",
              token: "verify-token",
            },
            event: {
              sender: { sender_type: "user", sender_id: { open_id: "ou-test" } },
              message: {
                message_id: "om-feishu-1",
                chat_id: "oc-test",
                chat_type: "p2p",
                message_type: "text",
                content: JSON.stringify({ text: "test sample" }),
              },
            },
          }),
        }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ code: 0 });

      for (let attempt = 0; attempt < 50 && (await store.listSessions()).length === 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const sessions = await store.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.externalChannel).toBe("feishu");
      expect(sessions[0]?.externalConversationId).toBe("oc-test");
      expect(sessions[0]?.runtimeSessionId).toBeTruthy();
    } finally {
      await projectManager.stop();
    }
  });

  it("lists action executions via GET /action-executions", async () => {
    const { gateway, store } = createTestGateway();

    await store.recordActionExecution({
      executionId: "act_test_gw_1",
      projectId: "test-proj",
      sessionId: "ses_gw_1",
      caller: "model",
      actionName: "send_notification",
      parameters: { title: "Test Alert" },
      status: "success",
      result: { sent: 1 },
      durationMs: 42,
    });

    const res = await gateway.handle(
      new Request("http://localhost/action-executions?projectId=test-proj"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.executions).toHaveLength(1);
    expect(body.executions[0].executionId).toBe("act_test_gw_1");
    expect(body.executions[0].actionName).toBe("send_notification");
    expect(body.executions[0].durationMs).toBe(42);
  });
});
