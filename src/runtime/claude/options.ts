import type {
  CanUseTool,
  EffortLevel,
  McpServerConfig as SdkMcpServerConfig,
  Options,
  SdkPluginConfig,
} from "@anthropic-ai/claude-agent-sdk";
import type { McpServerConfig, ProjectConfig } from "../../domain/types.ts";

/** Name of the in-process MCP server that exposes orchestrator actions. */
export const ACTION_SERVER_NAME = "orchestrator";

/** Built-in tools of a read-only session. */
export const CLAUDE_READ_ONLY_TOOLS = ["Read", "Grep", "Glob"];

const CLAUDE_EFFORT_LEVELS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

export interface QueryOptionsParams {
  project: ProjectConfig;
  workspacePath: string;
  sessionId: string;
  resume: boolean;
  /** Only Claude Code's read-only tools are offered. */
  readOnly?: boolean | undefined;
  actionServer?: SdkMcpServerConfig | undefined;
  /** Local plugins carrying the project's skills. */
  plugins?: SdkPluginConfig[] | undefined;
  canUseTool: CanUseTool;
  stderr: (data: string) => void;
}

/**
 * SDK options for one session's long-lived query. Everything not set here comes from Claude
 * Code's own configuration (CLAUDE_CONFIG_DIR, by default ~/.claude): login, default model,
 * permission mode, settings, MCP servers and hooks. The process inherits the service's
 * environment.
 */
export function buildQueryOptions(params: QueryOptionsParams): Options {
  const runtime = params.project.runtime;
  const effort = runtime?.reasoningEffort;
  const mcpServers = toSdkMcpServers(runtime?.mcpServers ?? []);
  if (params.actionServer) mcpServers[ACTION_SERVER_NAME] = params.actionServer;

  return {
    cwd: params.workspacePath,
    ...(params.resume ? { resume: params.sessionId } : { sessionId: params.sessionId }),
    ...(runtime?.model ? { model: runtime.model } : {}),
    ...(effort && CLAUDE_EFFORT_LEVELS.includes(effort) ? { effort: effort as EffortLevel } : {}),
    ...(params.readOnly ? { tools: CLAUDE_READ_ONLY_TOOLS } : {}),
    canUseTool: params.canUseTool,
    mcpServers,
    ...(params.plugins?.length ? { plugins: params.plugins } : {}),
    systemPrompt: { type: "preset", preset: "claude_code" },
    includePartialMessages: true,
    stderr: params.stderr,
  };
}

function toSdkMcpServers(servers: readonly McpServerConfig[]): Record<string, SdkMcpServerConfig> {
  const result: Record<string, SdkMcpServerConfig> = {};
  for (const server of servers) {
    const headers = server.http_headers ?? server.headers;
    if (server.url) {
      result[server.name] = { type: "http", url: server.url, ...(headers ? { headers } : {}) };
    } else if (server.command) {
      result[server.name] = {
        type: "stdio",
        command: server.command,
        ...(server.args ? { args: server.args } : {}),
      };
    }
  }
  return result;
}
