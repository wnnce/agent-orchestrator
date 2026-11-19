import type { McpServerConfig } from "../../domain/types.ts";

/** A project's MCP servers as a `mcp_servers` config override for a Codex thread. */
export function codexMcpServers(servers: readonly McpServerConfig[]): Record<string, unknown> {
  return Object.fromEntries(servers.map((server) => [server.name, mcpServerEntry(server)]));
}

function mcpServerEntry(server: McpServerConfig): Record<string, unknown> {
  const entry: Record<string, unknown> = {};
  if (server.url) entry.url = server.url;
  if (server.command) {
    entry.command = server.command;
    if (server.args) entry.args = server.args;
  }
  if (server.auth) entry.auth = server.auth;
  const headers = server.http_headers ?? server.headers;
  if (headers && Object.keys(headers).length > 0) entry.http_headers = headers;
  if (server.required !== undefined) entry.required = server.required;
  if (server.startupTimeoutSec !== undefined) entry.startup_timeout_sec = server.startupTimeoutSec;
  if (server.toolTimeoutSec !== undefined) entry.tool_timeout_sec = server.toolTimeoutSec;
  if (server.enabledTools) entry.enabled_tools = server.enabledTools;
  if (server.disabledTools) entry.disabled_tools = server.disabledTools;
  if (server.approvalMode) entry.default_tools_approval_mode = server.approvalMode;
  return entry;
}
