import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerConfig } from "../domain/types.ts";
import { Logger } from "../observability/logger.ts";

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;

export interface McpToolCallOptions {
  /** Per-call timeout in milliseconds (defaults to server.toolTimeoutSec * 1000 or 60_000). */
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface McpToolResult<T = unknown> {
  /**
   * Unwrapped payload resolved in order:
   * 1) `structuredContent` (when returned by the MCP server)
   * 2) `JSON.parse(text)` (when `text` is valid JSON)
   * 3) `text` (plain text fallback)
   */
  readonly data: T;
  /** Concatenated text from all `type: "text"` content blocks. */
  readonly text: string;
  /** Raw MCP content blocks. */
  readonly content: readonly Record<string, unknown>[];
  /** Raw MCP structuredContent when provided by the server. */
  readonly structuredContent?: Record<string, unknown> | undefined;
}

export interface McpToolInfo {
  readonly name: string;
  readonly description?: string | undefined;
  readonly inputSchema?: Record<string, unknown> | undefined;
}

export interface RawMcpCallToolResponse {
  readonly content?: unknown;
  readonly structuredContent?: unknown;
  readonly isError?: unknown;
}

export interface RawMcpListToolsResponse {
  readonly tools?: ReadonlyArray<{
    readonly name: string;
    readonly description?: string | undefined;
    readonly inputSchema?: Record<string, unknown> | undefined;
  }>;
}

/** Minimal MCP client abstraction enabling dependency injection and testing. */
export interface McpClientLike {
  callTool(
    params: { readonly name: string; readonly arguments?: Record<string, unknown> | undefined },
    options?: { readonly timeout?: number | undefined; readonly signal?: AbortSignal | undefined },
  ): Promise<RawMcpCallToolResponse>;
  listTools(options?: {
    readonly timeout?: number | undefined;
    readonly signal?: AbortSignal | undefined;
  }): Promise<RawMcpListToolsResponse>;
  close(): Promise<void>;
}

export type McpClientFactory = (
  server: McpServerConfig,
  context: {
    readonly workdir?: string | undefined;
    readonly env?: Readonly<Record<string, string>> | undefined;
    readonly signal?: AbortSignal | undefined;
  },
) => Promise<McpClientLike>;

export interface ProjectMcpClientPoolOptions {
  readonly servers: readonly McpServerConfig[];
  readonly workdir?: string | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly logger?: Logger | undefined;
  readonly clientFactory?: McpClientFactory | undefined;
}

function buildHttpHeaders(server: McpServerConfig): Record<string, string> {
  const headers: Record<string, string> = {
    ...(server.headers ?? {}),
    ...(server.http_headers ?? {}),
  };
  if (server.auth) {
    const hasAuthHeader = Object.keys(headers).some((k) => k.toLowerCase() === "authorization");
    if (!hasAuthHeader) {
      headers.Authorization = server.auth;
    }
  }
  return headers;
}

function combineSignals(
  a?: AbortSignal,
  b?: AbortSignal,
): AbortSignal | undefined {
  if (a && b) return AbortSignal.any([a, b]);
  return a ?? b;
}

function isToolAllowed(server: McpServerConfig, toolName: string): boolean {
  if (server.disabledTools?.includes(toolName)) {
    return false;
  }
  if (server.enabledTools && server.enabledTools.length > 0) {
    return server.enabledTools.includes(toolName);
  }
  return true;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Unwraps a raw MCP `tools/call` response into a normalized `McpToolResult<T>`.
 * Throws when `isError === true`.
 */
export function unwrapMcpToolResult<T = unknown>(
  raw: RawMcpCallToolResponse,
  serverName: string,
  toolName: string,
): McpToolResult<T> {
  const rawContent = Array.isArray(raw.content)
    ? raw.content.filter((item): item is Record<string, unknown> => isPlainRecord(item))
    : [];

  const textParts: string[] = [];
  for (const item of rawContent) {
    if (item.type === "text" && typeof item.text === "string") {
      textParts.push(item.text);
    }
  }
  const text = textParts.join("\n");
  const structuredContent = isPlainRecord(raw.structuredContent)
    ? raw.structuredContent
    : undefined;

  if (raw.isError === true) {
    const detail =
      text.trim() ||
      (structuredContent ? JSON.stringify(structuredContent) : JSON.stringify(rawContent)) ||
      "unknown error";
    throw new Error(`MCP tool "${serverName}.${toolName}" failed: ${detail}`);
  }

  let data: unknown;
  if (structuredContent !== undefined) {
    data = structuredContent;
  } else {
    const trimmed = text.trim();
    if (trimmed.length > 0) {
      try {
        data = JSON.parse(trimmed);
      } catch {
        data = text;
      }
    } else {
      data = text;
    }
  }

  return {
    data: data as T,
    text,
    content: rawContent,
    ...(structuredContent !== undefined ? { structuredContent } : {}),
  };
}

/** Default MCP client factory backed by `@modelcontextprotocol/sdk`. */
export const createSdkMcpClient: McpClientFactory = async (server, context) => {
  const client = new Client(
    { name: "agent-orchestrator", version: "0.1.0" },
    { capabilities: {} },
  );

  const startupTimeoutMs =
    server.startupTimeoutSec && server.startupTimeoutSec > 0
      ? server.startupTimeoutSec * 1000
      : DEFAULT_STARTUP_TIMEOUT_MS;

  if (server.url) {
    const headers = buildHttpHeaders(server);
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers },
    });
    await client.connect(transport, {
      timeout: startupTimeoutMs,
      ...(context.signal ? { signal: context.signal } : {}),
    });
  } else if (server.command) {
    const mergedEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) mergedEnv[k] = v;
    }
    if (context.env) {
      Object.assign(mergedEnv, context.env);
    }
    const transport = new StdioClientTransport({
      command: server.command,
      ...(server.args ? { args: [...server.args] } : {}),
      env: mergedEnv,
      ...(context.workdir ? { cwd: context.workdir } : {}),
    });
    await client.connect(transport, {
      timeout: startupTimeoutMs,
      ...(context.signal ? { signal: context.signal } : {}),
    });
  } else {
    throw new Error(
      `MCP server "${server.name}" must configure either "url" (HTTP) or "command" (stdio)`,
    );
  }

  return {
    callTool: async (params, options) => {
      const requestOptions = {
        ...(options?.timeout !== undefined ? { timeout: options.timeout } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
      };
      const result = await client.callTool(
        {
          name: params.name,
          ...(params.arguments !== undefined ? { arguments: params.arguments } : {}),
        },
        undefined,
        requestOptions,
      );
      return result as RawMcpCallToolResponse;
    },
    listTools: async (options) => {
      const requestOptions = {
        ...(options?.timeout !== undefined ? { timeout: options.timeout } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
      };
      const result = await client.listTools(undefined, requestOptions);
      return result as RawMcpListToolsResponse;
    },
    close: () => client.close(),
  };
};

/**
 * Lazy, per-execution MCP client pool scoped to a single TS task or pipeline node run.
 *
 * - Lazily connects to each configured MCP server on first use (deduplicating concurrent callers).
 * - Reuses the established client for all subsequent calls within the same execution.
 * - Enforces `enabledTools` / `disabledTools` policies from `project.yaml`.
 * - Releases all open HTTP sessions and stdio subprocesses on `close()`.
 */
export class ProjectMcpClientPool {
  private readonly serverMap = new Map<string, McpServerConfig>();
  private readonly clients = new Map<string, Promise<McpClientLike>>();
  private readonly logger: Logger;
  private readonly clientFactory: McpClientFactory;
  private closed = false;

  constructor(private readonly options: ProjectMcpClientPoolOptions) {
    for (const server of options.servers) {
      this.serverMap.set(server.name, server);
    }
    this.logger = options.logger ?? new Logger();
    this.clientFactory = options.clientFactory ?? createSdkMcpClient;
  }

  private requireServer(serverName: string): McpServerConfig {
    const server = this.serverMap.get(serverName);
    if (!server) {
      const available = Array.from(this.serverMap.keys());
      throw new Error(
        `MCP server "${serverName}" is not configured for this project` +
          (available.length > 0 ? ` (available: ${available.join(", ")})` : ""),
      );
    }
    return server;
  }

  private getClient(server: McpServerConfig, signal?: AbortSignal): Promise<McpClientLike> {
    if (this.closed) {
      return Promise.reject(new Error("MCP client pool has already been closed"));
    }

    const existing = this.clients.get(server.name);
    if (existing) {
      return existing;
    }

    const connectSignal = combineSignals(this.options.signal, signal);
    const pending = this.clientFactory(server, {
      workdir: this.options.workdir,
      env: this.options.env,
      signal: connectSignal,
    })
      .then(async (client) => {
        if (this.closed) {
          await client.close().catch(() => {});
          throw new Error("MCP client pool was closed while connecting");
        }
        return client;
      })
      .catch((err) => {
        // Evict failed connection attempt so subsequent retries can reconnect cleanly.
        if (this.clients.get(server.name) === pending) {
          this.clients.delete(server.name);
        }
        throw err;
      });

    this.clients.set(server.name, pending);
    return pending;
  }

  async callTool<T = unknown>(
    serverName: string,
    toolName: string,
    args?: Record<string, unknown>,
    callOptions?: McpToolCallOptions,
  ): Promise<McpToolResult<T>> {
    const server = this.requireServer(serverName);
    if (!isToolAllowed(server, toolName)) {
      throw new Error(`MCP tool "${serverName}.${toolName}" is not allowed by project policy`);
    }

    const startedAt = Date.now();
    const timeoutMs =
      callOptions?.timeoutMs ??
      (server.toolTimeoutSec && server.toolTimeoutSec > 0
        ? server.toolTimeoutSec * 1000
        : DEFAULT_TOOL_TIMEOUT_MS);
    const effectiveSignal = combineSignals(this.options.signal, callOptions?.signal);

    try {
      const client = await this.getClient(server, callOptions?.signal);
      const raw = await client.callTool(
        {
          name: toolName,
          ...(args !== undefined ? { arguments: args } : {}),
        },
        {
          timeout: timeoutMs,
          ...(effectiveSignal ? { signal: effectiveSignal } : {}),
        },
      );
      const unwrapped = unwrapMcpToolResult<T>(raw, serverName, toolName);
      this.logger.debug("mcp tool call completed", {
        server: serverName,
        tool: toolName,
        durationMs: Date.now() - startedAt,
      });
      return unwrapped;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn("mcp tool call failed", {
        server: serverName,
        tool: toolName,
        durationMs: Date.now() - startedAt,
        error: message,
      });
      throw err;
    }
  }

  async listTools(
    serverName: string,
    callOptions?: McpToolCallOptions,
  ): Promise<readonly McpToolInfo[]> {
    const server = this.requireServer(serverName);
    const timeoutMs =
      callOptions?.timeoutMs ??
      (server.toolTimeoutSec && server.toolTimeoutSec > 0
        ? server.toolTimeoutSec * 1000
        : DEFAULT_TOOL_TIMEOUT_MS);
    const effectiveSignal = combineSignals(this.options.signal, callOptions?.signal);

    const client = await this.getClient(server, callOptions?.signal);
    const raw = await client.listTools({
      timeout: timeoutMs,
      ...(effectiveSignal ? { signal: effectiveSignal } : {}),
    });

    const tools = raw.tools ?? [];
    return tools
      .filter((tool) => isToolAllowed(server, tool.name))
      .map((tool) => ({
        name: tool.name,
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
      }));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    const entries = Array.from(this.clients.entries());
    this.clients.clear();

    await Promise.allSettled(
      entries.map(async ([serverName, clientPromise]) => {
        try {
          const client = await clientPromise;
          await client.close();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn("failed to close mcp client", {
            server: serverName,
            error: message,
          });
        }
      }),
    );
  }
}
