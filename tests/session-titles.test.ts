import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { ArtifactStore } from "../src/artifacts/store.ts";
import type { ProjectConfig } from "../src/domain/types.ts";
import { SessionTitleGenerator } from "../src/app/titles.ts";
import { Logger } from "../src/observability/logger.ts";
import { MemoryStore } from "../src/persistence/store.ts";
import { ProjectRuntime } from "../src/project/runtime.ts";
import { FakeRuntime } from "../src/runtime/runtime.ts";
import { WorkspaceManager } from "../src/workspace/workspace.ts";

const quiet = new Logger({ sink: () => {} });

describe("SessionTitleGenerator", () => {
  const config = { model: "chat-model", apiKey: "key", baseUrl: "https://llm.example.com/v1/" };

  test("uses the configured chat model and cleans its answer", async () => {
    let calledUrl = "";
    const fetchFn = (async (url: string) => {
      calledUrl = url;
      return Response.json({ choices: [{ message: { content: '"修复登录问题"。' } }] });
    }) as unknown as typeof fetch;
    const generator = new SessionTitleGenerator(config, quiet, fetchFn);
    expect(await generator.generate("登录页面点击没反应")).toBe("修复登录问题");
    expect(calledUrl).toBe("https://llm.example.com/v1/chat/completions");
  });

  test("falls back to the first line without a model or when the model fails", async () => {
    expect(await new SessionTitleGenerator(undefined, quiet).generate("# Fix CI\nmore")).toBe(
      "Fix CI",
    );
    const failing = (async () => new Response("busy", { status: 503 })) as unknown as typeof fetch;
    expect(await new SessionTitleGenerator(config, quiet, failing).generate("Deploy v2")).toBe(
      "Deploy v2",
    );
    expect(await new SessionTitleGenerator(undefined, quiet).generate("   ")).toBeUndefined();
  });
});

describe("session titles", () => {
  let root: string;
  let store: MemoryStore;
  let runtime: ProjectRuntime;

  beforeEach(async () => {
    root = await mkdtemp("/tmp/session-titles-");
    store = new MemoryStore();
    const project: ProjectConfig = {
      id: "titles",
      displayName: "Titles",
      description: "test",
      routing: { projectId: "titles" },
      repository: { url: "", baseBranch: "main" },
      runtime: { type: "fake" },
    };
    runtime = new ProjectRuntime({
      project,
      store,
      agentRuntime: new FakeRuntime(),
      workspaces: new WorkspaceManager(path.join(root, "workspaces")),
      artifacts: new ArtifactStore(path.join(root, "artifacts"), store),
      logger: quiet,
    });
  });

  afterEach(async () => {
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  });

  test("a new session has no title until one is generated", async () => {
    const session = await runtime.createSession();
    expect(session.title).toBeUndefined();
    await runtime.setGeneratedTitle(session.sessionId, "Generated");
    expect((await store.getSession(session.sessionId))?.title).toBe("Generated");
  });

  test("a generated title never replaces one the user chose", async () => {
    const session = await runtime.createSession();
    await runtime.renameSession(session.sessionId, "Mine");
    await runtime.setGeneratedTitle(session.sessionId, "Generated");
    expect((await store.getSession(session.sessionId))?.title).toBe("Mine");
    const renamed = (await runtime.events(session.sessionId)).filter(
      (e) => e.type === "session.renamed",
    );
    expect(renamed).toHaveLength(1);
  });

  test("saving session state does not touch the title", async () => {
    const session = await runtime.createSession();
    await store.updateSessionTitle(session.sessionId, "Set elsewhere");
    await runtime.turn(session.sessionId, "hello");
    await runtime.waitForIdle(session.sessionId);
    expect((await store.getSession(session.sessionId))?.title).toBe("Set elsewhere");
  });
});
