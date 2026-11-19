import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { ActionRegistry } from "../src/actions/registry.ts";
import type { ProjectConfig, ProjectRuntimeConfig } from "../src/domain/types.ts";
import {
  buildQueryOptions,
  createActionServer,
  type QueryOptionsParams,
} from "../src/runtime/claude/index.ts";

const project = (runtime: ProjectRuntimeConfig = {}): ProjectConfig => ({
  id: "p",
  displayName: "P",
  description: "test",
  routing: { projectId: "p" },
  runtime: { type: "claude", ...runtime },
});

const options = (overrides: Partial<QueryOptionsParams> = {}) =>
  buildQueryOptions({
    project: project(),
    workspacePath: "/work",
    sessionId: "session-1",
    resume: false,
    canUseTool: async () => ({ behavior: "deny", message: "no" }),
    stderr: () => {},
    ...overrides,
  });

describe("Claude Code options", () => {
  test("only the project's choices are set; the rest comes from Claude Code's configuration", () => {
    const result = options();
    expect(result).toMatchObject({
      cwd: "/work",
      sessionId: "session-1",
      systemPrompt: { type: "preset", preset: "claude_code" },
      includePartialMessages: true,
    });
    for (const key of ["env", "settingSources", "permissionMode", "model", "effort", "tools"]) {
      expect(result).not.toHaveProperty(key);
    }
  });

  test("model, effort and MCP servers come from the project", () => {
    const result = options({
      project: project({
        model: "claude-sonnet-5-5",
        reasoningEffort: "high",
        mcpServers: [
          { name: "remote", url: "https://mcp.example.com", headers: { a: "b" } },
          { name: "local", command: "node", args: ["server.js"] },
        ],
      }),
    });
    expect(result.model).toBe("claude-sonnet-5-5");
    expect(result.effort).toBe("high");
    expect(result.mcpServers).toEqual({
      remote: { type: "http", url: "https://mcp.example.com", headers: { a: "b" } },
      local: { type: "stdio", command: "node", args: ["server.js"] },
    });
    // A level Claude Code does not have is left to its default.
    expect(options({ project: project({ reasoningEffort: "minimal" }) }).effort).toBeUndefined();
  });

  test("starts or resumes the session by id", () => {
    expect(options().sessionId).toBe("session-1");
    const resumed = options({ resume: true });
    expect(resumed.resume).toBe("session-1");
    expect(resumed.sessionId).toBeUndefined();
  });

  test("a read-only session offers only read-only tools", () => {
    expect(options({ readOnly: true }).tools).toEqual(["Read", "Grep", "Glob"]);
  });

  test("skill plugins are passed through", () => {
    const plugins = [{ type: "local" as const, path: "/data/claude-plugins/p/p" }];
    expect(options({ plugins }).plugins).toEqual(plugins);
    expect(options({ plugins: [] })).not.toHaveProperty("plugins");
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
    expect(options({ actionServer: server }).mcpServers?.orchestrator).toBe(server!);
  });
});
