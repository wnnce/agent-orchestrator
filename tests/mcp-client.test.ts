import { describe, expect, it } from "bun:test";
import type { McpServerConfig } from "../src/domain/types.ts";
import {
  ProjectMcpClientPool,
  createSdkMcpClient,
  unwrapMcpToolResult,
  type McpClientFactory,
  type McpClientLike,
} from "../src/mcp/index.ts";
import { TsTaskExecutor } from "../src/task/executors/ts.ts";
import type { TaskDefinition } from "../src/task/types.ts";

describe("unwrapMcpToolResult", () => {
  it("prefers structuredContent, falls back to parsed JSON text, then plain text", () => {
    const structured = unwrapMcpToolResult<{ ok: boolean }>(
      {
        structuredContent: { ok: true },
        content: [{ type: "text", text: "ignored text" }],
      },
      "srv",
      "tool",
    );
    expect(structured.data).toEqual({ ok: true });
    expect(structured.text).toBe("ignored text");
    expect(structured.structuredContent).toEqual({ ok: true });

    const jsonText = unwrapMcpToolResult<{ count: number }>(
      { content: [{ type: "text", text: '{"count":3}' }] },
      "srv",
      "tool",
    );
    expect(jsonText.data).toEqual({ count: 3 });

    const plainText = unwrapMcpToolResult<string>(
      {
        content: [
          { type: "text", text: "line 1" },
          { type: "text", text: "line 2" },
        ],
      },
      "srv",
      "tool",
    );
    expect(plainText.data).toBe("line 1\nline 2");
    expect(plainText.text).toBe("line 1\nline 2");
  });

  it("throws when MCP server sets isError=true", () => {
    expect(() =>
      unwrapMcpToolResult(
        { isError: true, content: [{ type: "text", text: "permission denied" }] },
        "github",
        "create_issue",
      ),
    ).toThrow('MCP tool "github.create_issue" failed: permission denied');
  });
});

describe("ProjectMcpClientPool", () => {
  const servers: McpServerConfig[] = [
    {
      name: "github",
      url: "https://example.invalid/mcp",
      toolTimeoutSec: 15,
      enabledTools: ["list_issues", "get_issue"],
    },
    {
      name: "tracker",
      url: "https://tracker.invalid/mcp",
      disabledTools: ["delete_ticket"],
    },
  ];

  it("lazily connects once per server, deduplicates concurrent calls, reuses client, and closes all on close()", async () => {
    const connectCounts = new Map<string, number>();
    const closeCounts = new Map<string, number>();
    const callRecords: Array<{ server: string; tool: string; timeout?: number | undefined }> = [];

    const factory: McpClientFactory = async (server) => {
      connectCounts.set(server.name, (connectCounts.get(server.name) ?? 0) + 1);
      await new Promise((r) => setTimeout(r, 10));
      const client: McpClientLike = {
        async callTool(params, options) {
          callRecords.push({ server: server.name, tool: params.name, timeout: options?.timeout });
          return { structuredContent: { server: server.name, tool: params.name, args: params.arguments } };
        },
        async listTools() {
          return {
            tools: [
              { name: "list_issues", description: "List issues" },
              { name: "get_issue", description: "Get issue" },
              { name: "delete_repo", description: "Blocked" },
            ],
          };
        },
        async close() {
          closeCounts.set(server.name, (closeCounts.get(server.name) ?? 0) + 1);
        },
      };
      return client;
    };

    const pool = new ProjectMcpClientPool({ servers, clientFactory: factory });

    // No server connected before first call
    expect(connectCounts.size).toBe(0);

    // Concurrent calls to the same server only connect once
    const [r1, r2] = await Promise.all([
      pool.callTool("github", "list_issues", { page: 1 }),
      pool.callTool("github", "get_issue", { number: 42 }),
    ]);
    expect(r1.data).toEqual({ server: "github", tool: "list_issues", args: { page: 1 } });
    expect(r2.data).toEqual({ server: "github", tool: "get_issue", args: { number: 42 } });
    expect(connectCounts.get("github")).toBe(1);
    expect(connectCounts.get("tracker")).toBeUndefined(); // Unused server never connected
    expect(callRecords[0]?.timeout).toBe(15_000);

    // Subsequent call reuses existing client and respects enabledTools filter in listTools
    const tools = await pool.listTools("github");
    expect(tools.map((t) => t.name)).toEqual(["list_issues", "get_issue"]);
    expect(connectCounts.get("github")).toBe(1);

    await pool.close();
    expect(closeCounts.get("github")).toBe(1);
    expect(closeCounts.get("tracker")).toBeUndefined();
  });

  it("enforces enabledTools / disabledTools and rejects unknown servers", async () => {
    let factoryCalls = 0;
    const pool = new ProjectMcpClientPool({
      servers,
      clientFactory: async () => {
        factoryCalls += 1;
        return {
          callTool: async () => ({ content: [] }),
          listTools: async () => ({ tools: [] }),
          close: async () => {},
        };
      },
    });

    await expect(pool.callTool("unknown", "ping")).rejects.toThrow(
      'MCP server "unknown" is not configured',
    );
    await expect(pool.callTool("github", "delete_repo")).rejects.toThrow("not allowed");
    await expect(pool.callTool("tracker", "delete_ticket")).rejects.toThrow("not allowed");
    // Policy rejection happens before establishing any connection
    expect(factoryCalls).toBe(0);
    await pool.close();
  });

  it("evicts failed connection promises so retries can reconnect", async () => {
    let attempts = 0;
    const pool = new ProjectMcpClientPool({
      servers: [{ name: "flaky", url: "https://flaky.invalid/mcp" }],
      clientFactory: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient connect failure");
        return {
          callTool: async () => ({ structuredContent: { ok: true } }),
          listTools: async () => ({ tools: [] }),
          close: async () => {},
        };
      },
    });

    await expect(pool.callTool("flaky", "ping")).rejects.toThrow("transient connect failure");
    const res = await pool.callTool<{ ok: boolean }>("flaky", "ping");
    expect(res.data).toEqual({ ok: true });
    expect(attempts).toBe(2);
    await pool.close();
  });
});

describe("createSdkMcpClient + TsTaskExecutor integration", () => {
  it("calls a real local Streamable HTTP MCP server and cleans up connections after task finishes", async () => {
    let receivedAuth = "";
    let initCount = 0;
    let toolCallCount = 0;

    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        if (req.method === "GET") {
          return new Response(null, { status: 405 });
        }
        if (req.method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        receivedAuth = req.headers.get("authorization") ?? "";
        const body = (await req.json()) as {
          id?: number | string;
          method: string;
          params?: { name?: string; arguments?: Record<string, unknown> };
        };

        if (body.method === "initialize") {
          initCount += 1;
          return Response.json(
            {
              jsonrpc: "2.0",
              id: body.id,
              result: {
                protocolVersion: "2025-03-26",
                capabilities: { tools: {} },
                serverInfo: { name: "mock-http-mcp", version: "1.0.0" },
              },
            },
            { headers: { "mcp-session-id": "mock-session-1" } },
          );
        }

        if (body.method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }

        if (body.method === "tools/list") {
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              tools: [{ name: "echo", description: "Echo input", inputSchema: { type: "object" } }],
            },
          });
        }

        if (body.method === "tools/call") {
          toolCallCount += 1;
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              content: [{ type: "text", text: JSON.stringify(body.params?.arguments ?? {}) }],
              structuredContent: {
                called: body.params?.name,
                args: body.params?.arguments ?? {},
                callIndex: toolCallCount,
              },
            },
          });
        }

        return new Response("Not found", { status: 404 });
      },
    });

    try {
      const mcpServers: McpServerConfig[] = [
        {
          name: "mock",
          url: `http://127.0.0.1:${server.port}/mcp`,
          http_headers: { Authorization: "Bearer test-secret-token" },
        },
      ];

      const task: TaskDefinition = {
        taskKey: "demo:mcp-smoke",
        projectId: "demo",
        taskId: "mcp-smoke",
        name: "MCP Smoke Task",
        cron: "0 * * * *",
        enabled: true,
        promptTemplate: "",
        filePath: "/tmp/mcp-smoke.ts",
        sourceFormat: "typescript",
        type: "ts",
      };

      const executor = new TsTaskExecutor({
        getMcpServers: () => mcpServers,
        mcpClientFactory: createSdkMcpClient,
        resolveHandler: async () => async (ctx) => {
          const tools = await ctx.listMcpTools("mock");
          const first = await ctx.callMcpTool<{ callIndex: number; args: { page: number } }>(
            "mock",
            "echo",
            { page: 1 },
          );
          const second = await ctx.callMcpTool<{ callIndex: number; args: { page: number } }>(
            "mock",
            "echo",
            { page: 2 },
          );
          return {
            summary: {
              toolNames: tools.map((t) => t.name),
              firstIndex: first.data.callIndex,
              secondIndex: second.data.callIndex,
            },
          };
        },
      });

      const res = await executor.execute({
        executionId: "exec_mcp_1",
        task,
        stateBefore: {},
      });

      expect(res.success).toBe(true);
      expect(receivedAuth).toBe("Bearer test-secret-token");
      // Initialized only once across listMcpTools + 2 callMcpTool calls
      expect(initCount).toBe(1);
      expect(toolCallCount).toBe(2);
      expect(res.actionsSummary).toEqual({
        toolNames: ["echo"],
        firstIndex: 1,
        secondIndex: 2,
      });
    } finally {
      await server.stop(true);
    }
  });
});
