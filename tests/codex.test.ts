import { test, expect } from "bun:test";
import { mkdir, mkdtemp, writeFile, chmod, rm, realpath } from "node:fs/promises";
import path from "node:path";
import { CodexRuntime } from "../src/runtime/codex/index.ts";
import type { RuntimeEvent } from "../src/runtime/runtime.ts";
import type { ProjectConfig } from "../src/domain/types.ts";
import { Logger } from "../src/observability/logger.ts";

const project: ProjectConfig = {
  id: "codex-test",
  displayName: "Codex Test",
  description: "test",
  routing: {
    projectId: "codex-test",
    displayName: "Codex Test",
    summary: "test",
    keywords: [],
    routingHints: [],
  },
  runtime: { type: "codex" },
};

test("Codex runtime speaks app-server JSONL", async () => {
  const root = await mkdtemp("/tmp/codex-runtime-");
  const script = path.join(root, "fake-codex");
  await writeFile(
    script,
    `#!/usr/bin/env bun\nimport { createInterface } from "node:readline";\nconst rl = createInterface({ input: process.stdin });\nrl.on("line", line => { const m = JSON.parse(line); if (m.method === "initialize") console.log(JSON.stringify({ id: m.id, result: {} })); else if (m.method === "thread/start") console.log(JSON.stringify({ id: m.id, result: { thread: { id: "thread-test" } } })); else if (m.method === "thread/resume") console.log(JSON.stringify({ id: m.id, result: { thread: { id: "thread-test" } } })); else if (m.method === "turn/start") { console.log(JSON.stringify({ id: m.id, result: { turn: { id: "runtime-turn" } } })); console.log(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: "thread-test", turnId: "runtime-turn", itemId: "msg-1", delta: "hello" } })); console.log(JSON.stringify({ method: "turn/completed", params: { threadId: "thread-test", turn: { id: "runtime-turn", status: "completed", items: [], error: null, durationMs: null } } })); } });\n`,
    { mode: 0o755 },
  );
  await chmod(script, 0o755);
  const runtime = new CodexRuntime(script);
  const events: string[] = [];
  const context = {
    project,
    workspacePath: root,
    onEvent: (event: RuntimeEvent) => {
      events.push(event.type);
    },
  };
  const session = await runtime.startSession(context);
  expect(session.id).toBe("thread-test");
  const turn = await runtime.startTurn(context, session.id, "gateway-turn", "hello");
  expect(turn.id).toBe("runtime-turn");
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(events).toContain("agent.message.delta");
  expect(events).toContain("turn.completed");
  await runtime.stop();
  await rm(root, { recursive: true, force: true });
});

test("a thread carries only what the project sets on top of Codex's own configuration", async () => {
  const root = await realpath(await mkdtemp("/tmp/codex-overrides-"));
  const log = path.join(root, "received.jsonl");
  const script = path.join(root, "fake-codex");
  await writeFile(
    script,
    `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const send = (m) => console.log(JSON.stringify(m));
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ env: { CODEX_HOME: process.env.CODEX_HOME ?? null, OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? null } }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  appendFileSync(${JSON.stringify(log)}, line + "\\n");
  const m = JSON.parse(line);
  if (m.method === "initialize") send({ id: m.id, result: {} });
  else if (m.method === "thread/start") send({ id: m.id, result: { thread: { id: "thread-1" } } });
  else if (m.method === "turn/start") send({ id: m.id, result: { turn: { id: "turn-1" } } });
});
`,
    { mode: 0o755 },
  );
  const previous = { home: process.env.CODEX_HOME, key: process.env.OPENAI_API_KEY };
  process.env.CODEX_HOME = "/home/user/.codex-orchestrator";
  process.env.OPENAI_API_KEY = "from-environment";
  const runtime = new CodexRuntime(script, new Logger({ sink: () => {} }));
  try {
    const context = {
      project: {
        ...project,
        runtime: {
          type: "codex",
          model: "gpt-5",
          reasoningEffort: "high" as const,
          mcpServers: [{ name: "docs", url: "https://mcp.example.com/docs" }],
        },
      },
      workspacePath: root,
      onEvent: () => {},
    };
    const session = await runtime.startSession(context);
    await runtime.startTurn(context, session.id, "turn", "hello");

    const lines = (await Bun.file(log).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    // The app-server inherits the service's environment untouched.
    expect(lines[0].env).toEqual({
      CODEX_HOME: "/home/user/.codex-orchestrator",
      OPENAI_API_KEY: "from-environment",
    });
    const start = lines.find((m) => m.method === "thread/start");
    expect(start.params).toMatchObject({
      cwd: root,
      model: "gpt-5",
      config: { mcp_servers: { docs: { url: "https://mcp.example.com/docs" } } },
    });
    // Approval policy and sandbox are left to Codex's own configuration.
    expect(start.params.approvalPolicy).toBeUndefined();
    expect(start.params.sandbox).toBeUndefined();
    expect(lines.find((m) => m.method === "turn/start").params.effort).toBe("high");
  } finally {
    await runtime.stop();
    process.env.CODEX_HOME = previous.home;
    process.env.OPENAI_API_KEY = previous.key;
    if (previous.home === undefined) delete process.env.CODEX_HOME;
    if (previous.key === undefined) delete process.env.OPENAI_API_KEY;
    await rm(root, { recursive: true, force: true });
  }
});
