import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectConfig } from "../src/domain/types.ts";
import { Logger } from "../src/observability/logger.ts";
import { CodexRuntime } from "../src/runtime/codex.ts";
import type { RuntimeContext, RuntimeEvent } from "../src/runtime/runtime.ts";

/**
 * A scripted app-server. It records every message it receives in `<dir>/received.jsonl`, fails
 * `initialize` once when `<dir>/fail-init` exists, and after turn/start asks
 * the client three questions: a command approval for its thread, an MCP elicitation, and a file
 * change approval for a thread nobody is attached to.
 */
const fakeServer = (dir: string) => `#!/usr/bin/env bun
import { appendFileSync, existsSync, rmSync } from "node:fs";
process.chdir(${JSON.stringify(dir)});
import { createInterface } from "node:readline";
const send = (message) => console.log(JSON.stringify(message));
createInterface({ input: process.stdin }).on("line", (line) => {
  appendFileSync("received.jsonl", line + "\\n");
  const m = JSON.parse(line);
  if (m.method === "initialize") {
    if (existsSync("fail-init")) {
      rmSync("fail-init");
      send({ id: m.id, error: { code: -32000, message: "init failed" } });
    } else send({ id: m.id, result: {} });
  } else if (m.method === "thread/start") {
    send({ id: m.id, result: { thread: { id: "thread-test" } } });
  } else if (m.method === "thread/unsubscribe") {
    send({ id: m.id, result: {} });
  } else if (m.method === "turn/start") {
    send({ id: m.id, result: { turn: { id: "runtime-turn" } } });
    send({ id: "req-approve", method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-test", turnId: "runtime-turn", itemId: "c1", command: "rm -rf build" } });
    send({ id: "req-elicit", method: "mcpServer/elicitation/request", params: { threadId: "thread-test" } });
    send({ id: "req-orphan", method: "item/fileChange/requestApproval",
      params: { threadId: "other-thread", turnId: "t", itemId: "f1" } });
  }
});
`;

describe("Codex app-server protocol", () => {
  let root: string;
  let serverDir: string;
  let runtime: CodexRuntime;
  let events: RuntimeEvent[];
  let context: RuntimeContext;

  beforeEach(async () => {
    root = await mkdtemp("/tmp/codex-protocol-");
    serverDir = path.join(root, "server");
    await mkdir(serverDir);
    const script = path.join(root, "fake-codex");
    await writeFile(script, fakeServer(serverDir), { mode: 0o755 });
    runtime = new CodexRuntime(script, new Logger({ sink: () => {} }));
    events = [];
    const project: ProjectConfig = {
      id: "codex-protocol",
      displayName: "Codex Protocol",
      description: "test",
      routing: { projectId: "codex-protocol" },
      runtime: { type: "codex" },
    };
    context = { project, workspacePath: root, onEvent: (event) => void events.push(event) };
  });

  afterEach(async () => {
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  });

  async function received(): Promise<Array<Record<string, any>>> {
    const file = Bun.file(path.join(serverDir, "received.jsonl"));
    if (!(await file.exists())) return [];
    return (await file.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  }

  async function waitFor<T>(find: () => Promise<T | undefined>): Promise<T> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const value = await find();
      if (value !== undefined) return value;
      await Bun.sleep(10);
    }
    throw new Error("condition not met in time");
  }

  test("a failed handshake does not leave a half-started server behind", async () => {
    await Bun.write(path.join(serverDir, "fail-init"), "");
    await expect(runtime.startSession(context)).rejects.toThrow("init failed");
    const session = await runtime.startSession(context);
    expect(session.id).toBe("thread-test");
  });

  test("a read-only session gets the read-only sandbox", async () => {
    await runtime.startSession({ ...context, readOnly: true });
    const start = await waitFor(async () =>
      (await received()).find((m) => m.method === "thread/start"),
    );
    expect(start.params.sandbox).toBe("read-only");
  });

  test("a server stopped and started again keeps working", async () => {
    await runtime.startSession(context);
    await runtime.stop();
    const session = await runtime.startSession(context);
    await Bun.sleep(30);
    expect(session.id).toBe("thread-test");
    expect(events.some((e) => e.type === "runtime.disconnected")).toBe(false);
    await runtime.startTurn(context, session.id, "turn", "hello");
  });

  test("approval requests round-trip and unsupported requests are declined", async () => {
    const session = await runtime.startSession(context);
    await runtime.startTurn(context, session.id, "turn", "hello");

    const requested = await waitFor(async () =>
      events.find((e) => e.type === "approval.requested"),
    );
    expect(requested.payload).toMatchObject({
      requestId: "req-approve",
      actionType: "command",
      description: "rm -rf build",
    });

    const elicitation = await waitFor(async () =>
      (await received()).find((m) => m.id === "req-elicit"),
    );
    expect(elicitation.error.code).toBe(-32601);

    const orphan = await waitFor(async () => (await received()).find((m) => m.id === "req-orphan"));
    expect(orphan.result).toEqual({ decision: "decline" });

    await runtime.respondToApproval(context, "req-approve", "approved");
    const answer = await waitFor(async () =>
      (await received()).find((m) => m.id === "req-approve"),
    );
    expect(answer.result).toEqual({ decision: "accept" });
    await expect(runtime.respondToApproval(context, "req-approve", "approved")).rejects.toThrow(
      "no pending approval",
    );
  });

  test("releasing a session cancels the approvals it still waits on", async () => {
    const session = await runtime.startSession(context);
    await runtime.startTurn(context, session.id, "turn", "hello");
    await waitFor(async () => events.find((e) => e.type === "approval.requested"));

    await runtime.releaseSession(context, session.id);
    const answer = await waitFor(async () =>
      (await received()).find((m) => m.id === "req-approve"),
    );
    expect(answer.result).toEqual({ decision: "cancel" });
  });
});
