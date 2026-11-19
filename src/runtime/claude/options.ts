import type {
  CanUseTool,
  McpServerConfig as SdkMcpServerConfig,
  Options,
  PermissionMode,
} from "@anthropic-ai/claude-agent-sdk";
import type { ProjectConfig } from "../../domain/types.ts";
import {
  type ClaudeMcpServer,
  type ClaudeProjectRuntime,
  type ClaudeRuntimeConfig,
  claudeProjectRuntimeSchema,
} from "./types.ts";

/** Name of the in-process MCP server that exposes orchestrator actions. */
export const ACTION_SERVER_NAME = "orchestrator";

/** Built-in tools of a read-only session. */
export const CLAUDE_READ_ONLY_TOOLS = ["Read", "Grep", "Glob"];

/** Host variables Claude Code needs to run; everything else in the service's env stays private. */
const INHERITED_ENV = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TZ",
  "TMPDIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
];

/** Maps the project's Codex-style approval policy onto a Claude permission mode. */
const PERMISSION_MODES: Record<
  NonNullable<ClaudeProjectRuntime["approvalPolicy"]>,
  PermissionMode
> = {
  never: "bypassPermissions",
  "on-request": "default",
  "on-failure": "acceptEdits",
  untrusted: "default",
};

export interface QueryOptionsParams {
  project: ProjectConfig;
  config: ClaudeRuntimeConfig;
  workspacePath: string;
  configDir: string;
  sessionId: string;
  resume: boolean;
  /** Only Claude Code's read-only tools are offered. */
  readOnly?: boolean | undefined;
  actionServer?: SdkMcpServerConfig | undefined;
  canUseTool: CanUseTool;
  stderr: (data: string) => void;
}

/** SDK options for one session's long-lived query. */
export function buildQueryOptions(params: QueryOptionsParams): Options {
  const { project, config } = params;
  const runtime = projectRuntime(project);
  const permissionMode = permissionModeFor(runtime);
  const model = runtime.model ?? config.model;
  const mcpServers = toSdkMcpServers([...(config.mcpServers ?? []), ...(runtime.mcpServers ?? [])]);
  if (params.actionServer) mcpServers[ACTION_SERVER_NAME] = params.actionServer;

  if (permissionMode === "bypassPermissions" && isRoot() && !config.sandboxed) {
    throw new Error(
      "Claude Code refuses bypassPermissions as root: set runtimes.claude.sandboxed: true when " +
        "the service runs in an isolated container, or choose another approvalPolicy",
    );
  }

  return {
    cwd: params.workspacePath,
    ...(params.resume ? { resume: params.sessionId } : { sessionId: params.sessionId }),
    env: buildEnv(project, config, params.configDir),
    settingSources: runtime.settingSources ?? config.settingSources ?? ["user", "project"],
    ...(model ? { model } : {}),
    ...(runtime.reasoningEffort ? { effort: runtime.reasoningEffort } : {}),
    permissionMode,
    allowDangerouslySkipPermissions: permissionMode === "bypassPermissions",
    canUseTool: params.canUseTool,
    tools: params.readOnly
      ? CLAUDE_READ_ONLY_TOOLS
      : (config.tools ?? { type: "preset", preset: "claude_code" }),
    mcpServers,
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      ...(config.appendSystemPrompt ? { append: config.appendSystemPrompt } : {}),
    },
    skills: "all",
    includePartialMessages: true,
    ...(config.executable ? { pathToClaudeCodeExecutable: config.executable } : {}),
    stderr: params.stderr,
  };
}

/**
 * The complete environment of the Claude Code process: `env` replaces the inherited environment,
 * so only the variables it needs, the project's own and the credentials are passed.
 */
export function buildEnv(
  project: ProjectConfig,
  config: ClaudeRuntimeConfig,
  configDir: string,
): Record<string, string> {
  if (!config.apiKey && !config.authToken && !config.oauthToken) {
    throw new Error("runtimes.claude needs apiKey, authToken or oauthToken in the service YAML");
  }
  const env: Record<string, string> = {};
  for (const key of INHERITED_ENV) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, project.env ?? {});
  env.CLAUDE_CONFIG_DIR = configDir;
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "agent-orchestrator";
  if (config.apiKey) env.ANTHROPIC_API_KEY = config.apiKey;
  if (config.authToken) env.ANTHROPIC_AUTH_TOKEN = config.authToken;
  if (config.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = config.oauthToken;
  if (config.baseUrl) env.ANTHROPIC_BASE_URL = config.baseUrl;
  if (config.sandboxed) env.IS_SANDBOX = "1";
  return env;
}

/** An explicit `runtime.permissionMode` wins over the mapped `approvalPolicy` (default "never"). */
export function permissionModeFor(runtime: ClaudeProjectRuntime): PermissionMode {
  return runtime.permissionMode ?? PERMISSION_MODES[runtime.approvalPolicy ?? "never"];
}

function isRoot(): boolean {
  return process.getuid?.() === 0;
}

export function projectRuntime(project: ProjectConfig): ClaudeProjectRuntime {
  return claudeProjectRuntimeSchema.parse(project.runtime ?? {});
}

function toSdkMcpServers(servers: ClaudeMcpServer[]): Record<string, SdkMcpServerConfig> {
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
