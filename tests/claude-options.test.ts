import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { ActionRegistry } from "../src/actions/registry.ts";
import type { ProjectConfig } from "../src/domain/types.ts";
import {
  buildEnv,
  buildQueryOptions,
  claudeRuntimeConfigSchema,
  createActionServer,
  permissionModeFor,
} from "../src/runtime/claude/index.ts";

const project = (runtime: Record<string, unknown> = {}): ProjectConfig => ({
  id: "p",
  displayName: "P",
  description: "test",
  routing: { projectId: "p" },
  env: { PROJECT_FLAG: "1" },
  runtime: { type: "claude", ...runtime },
});

const options = (runtime: Record<string, unknown> = {}, config: Record<string, unknown> = {}) =>
  buildQueryOptions({
    project: project(runtime),
    config: { apiKey: "sk-test", ...config },
    workspacePath: "/work",
    configDir: "/data/claude/p",
    sessionId: "session-1",
    resume: false,
    canUseTool: async () => ({ behavior: "deny", message: "no" }),
    stderr: () => {},
  });

describe("Claude Code options", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.DATABASE_URL = "postgres://secret";
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  test("the process gets only the variables it needs, the project's and the credentials", () => {
    const env = buildEnv(project(), { apiKey: "sk-test", baseUrl: "https://gw" }, "/cfg");
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.PATH).toBe(process.env.PATH!);
    expect(env).toMatchObject({
      PROJECT_FLAG: "1",
      CLAUDE_CONFIG_DIR: "/cfg",
      ANTHROPIC_API_KEY: "sk-test",
      ANTHROPIC_BASE_URL: "https://gw",
    });
    expect(buildEnv(project(), { oauthToken: "oat" }, "/cfg").CLAUDE_CODE_OAUTH_TOKEN).toBe("oat");
    expect(() => buildEnv(project(), {}, "/cfg")).toThrow("apiKey, authToken or oauthToken");
  });

  test("approval policy maps onto a permission mode; an explicit mode wins", () => {
    expect(permissionModeFor({})).toBe("bypassPermissions");
    expect(permissionModeFor({ approvalPolicy: "on-request" })).toBe("default");
    expect(permissionModeFor({ approvalPolicy: "on-failure" })).toBe("acceptEdits");
    expect(permissionModeFor({ approvalPolicy: "never", permissionMode: "plan" })).toBe("plan");
    expect(options().allowDangerouslySkipPermissions).toBe(true);
    expect(options({ approvalPolicy: "on-request" }).allowDangerouslySkipPermissions).toBe(false);
  });

  test("project settings override the service defaults; other runtimes' fields are ignored", () => {
    const result = options(
      {
        model: "claude-sonnet-5-5",
        reasoningEffort: "minimal",
        settingSources: ["user"],
        config: { model_reasoning_effort: "high" },
        providers: { openai: {} },
      },
      { model: "claude-opus-5-5" },
    );
    expect(result.model).toBe("claude-sonnet-5-5");
    expect(result.effort).toBeUndefined();
    expect(result.settingSources).toEqual(["user"]);
    expect(options({ reasoningEffort: "high" }).effort).toBe("high");
    expect(options().settingSources).toEqual(["user", "project"]);
    expect(options().model).toBeUndefined();
  });

  test("starts or resumes the session by id", () => {
    expect(options().sessionId).toBe("session-1");
    const resumed = buildQueryOptions({
      project: project(),
      config: { apiKey: "sk-test" },
      workspacePath: "/work",
      configDir: "/cfg",
      sessionId: "session-1",
      resume: true,
      canUseTool: async () => ({ behavior: "deny", message: "no" }),
      stderr: () => {},
    });
    expect(resumed.resume).toBe("session-1");
    expect(resumed.sessionId).toBeUndefined();
  });

  test("MCP servers are converted and merged from service and project", () => {
    const result = options(
      { mcpServers: [{ name: "local", command: "node", args: ["server.js"] }] },
      { mcpServers: [{ name: "remote", url: "https://mcp.example.com", headers: { a: "b" } }] },
    );
    expect(result.mcpServers).toEqual({
      remote: { type: "http", url: "https://mcp.example.com", headers: { a: "b" } },
      local: { type: "stdio", command: "node", args: ["server.js"] },
    });
  });

  test("orchestrator actions are offered through an in-process MCP server", () => {
    const registry = new ActionRegistry();
    const site = () => ({ project: project(), workspacePath: "/work", sessionId: "s" });
    expect(createActionServer(registry, undefined, site)).toBeUndefined();

    registry.register({
      name: "ping",
      description: "Replies pong",
      parameters: z.object({ text: z.string() }),
      handler: async () => ({ pong: true }),
    });
    const server = createActionServer(registry, undefined, site);
    expect(server).toMatchObject({ type: "sdk", name: "orchestrator" });

    const result = buildQueryOptions({
      project: project(),
      config: { apiKey: "sk-test" },
      workspacePath: "/work",
      configDir: "/cfg",
      sessionId: "s",
      resume: false,
      actionServer: server,
      canUseTool: async () => ({ behavior: "deny", message: "no" }),
      stderr: () => {},
    });
    expect(result.mcpServers?.orchestrator).toBe(server!);
  });

  test("skipping permissions as root requires a sandboxed service", () => {
    const getuid = process.getuid!;
    process.getuid = () => 0;
    try {
      expect(() => options()).toThrow("runtimes.claude.sandboxed");
      expect(options({ approvalPolicy: "on-request" }).permissionMode).toBe("default");
      expect(options({}, { sandboxed: true }).env?.IS_SANDBOX).toBe("1");
    } finally {
      process.getuid = getuid;
    }
  });

  test("the service config rejects unknown keys", () => {
    expect(() => claudeRuntimeConfigSchema.parse({ apikey: "typo" })).toThrow();
  });
});
