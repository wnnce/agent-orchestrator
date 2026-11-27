import { randomBytes, timingSafeEqual } from "node:crypto";
import type { McpServer } from "@agentclientprotocol/sdk";
import type { SessionTools } from "../../tools/types.ts";

export const ACP_TOOL_SERVER_NAME = "orchestrator";

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: string | number | null | undefined;
  method?: unknown;
  params?: unknown;
}

/**
 * Lightweight loopback HTTP MCP server exposing each session's orchestrator tools to ACP agent
 * subprocesses. Lazily bound on `127.0.0.1:0` and protected by a per-instance random bearer token.
 */
export class ACPMcpBridge {
  private readonly authToken = randomBytes(24).toString("hex");
  private readonly tokenBuf = Buffer.from(`Bearer ${this.authToken}`, "utf8");
  private readonly sessions = new Map<string, () => SessionTools | undefined>();
  private server: Bun.Server<undefined> | undefined;

  /** Registers how to find a session's current tools for incoming MCP requests. */
  registerSession(bridgeSessionId: string, tools: () => SessionTools | undefined): void {
    this.sessions.set(bridgeSessionId, tools);
  }

  unregisterSession(bridgeSessionId: string): void {
    this.sessions.delete(bridgeSessionId);
  }

  /**
   * Returns an ACP HTTP `McpServer` descriptor for the session, starting the bridge if needed.
   * Returns `undefined` when the session has no orchestrator tools.
   */
  mcpServerForSession(
    bridgeSessionId: string,
    tools: SessionTools | undefined,
  ): McpServer | undefined {
    if (!tools || tools.specs.length === 0) return undefined;
    const server = this.ensureStarted();
    return {
      type: "http",
      name: ACP_TOOL_SERVER_NAME,
      url: `http://127.0.0.1:${server.port}/mcp/${encodeURIComponent(bridgeSessionId)}`,
      headers: [{ name: "Authorization", value: `Bearer ${this.authToken}` }],
    };
  }

  stop(): void {
    this.sessions.clear();
    if (this.server) {
      this.server.stop(true);
      this.server = undefined;
    }
  }

  private ensureStarted(): Bun.Server<undefined> {
    if (this.server) return this.server;
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => this.handleRequest(req),
    });
    return this.server;
  }

  private isAuthorized(req: Request): boolean {
    const header = req.headers.get("authorization");
    if (!header) return false;
    const incoming = Buffer.from(header, "utf8");
    if (incoming.length !== this.tokenBuf.length) return false;
    return timingSafeEqual(incoming, this.tokenBuf);
  }

  private async handleRequest(req: Request): Promise<Response> {
    if (!this.isAuthorized(req)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    if (req.method !== "POST") {
      return Response.json({ error: "method_not_allowed" }, { status: 405 });
    }

    const url = new URL(req.url);
    const match = /^\/mcp\/([^/]+)$/.exec(url.pathname);
    if (!match?.[1]) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    const bridgeSessionId = decodeURIComponent(match[1]);
    const tools = this.sessions.get(bridgeSessionId)?.();
    if (!tools) {
      return Response.json({ error: "unknown_session" }, { status: 404 });
    }

    const body = (await req.json().catch(() => undefined)) as JsonRpcRequest | undefined;
    if (!body || typeof body.method !== "string") {
      return Response.json(
        { jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32600, message: "Invalid request" } },
        { status: 400 },
      );
    }

    const id = body.id;
    switch (body.method) {
      case "initialize":
        return Response.json({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: ACP_TOOL_SERVER_NAME, version: "0.1.0" },
          },
        });

      case "notifications/initialized":
      case "notifications/cancelled":
        return new Response(null, { status: 202 });

      case "server/discover":
      case "ping":
        return Response.json({ jsonrpc: "2.0", id, result: {} });

      case "tools/list": {
        const list = tools.specs.map((spec) => ({
          name: spec.name,
          description: spec.description,
          inputSchema: spec.inputSchema,
        }));
        return Response.json({ jsonrpc: "2.0", id, result: { tools: list } });
      }

      case "tools/call": {
        const params = (body.params ?? {}) as { name?: unknown; arguments?: unknown };
        const name = typeof params.name === "string" ? params.name : "";
        const result = await tools.call(name, params.arguments ?? {});
        return Response.json({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: result.text }], isError: !result.ok },
        });
      }

      default:
        if (id === undefined) return new Response(null, { status: 202 });
        return Response.json({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${body.method}` },
        });
    }
  }
}
