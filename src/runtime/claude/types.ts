import { z } from "zod";
import { mcpServerConfigSchema } from "../../domain/schemas.ts";

export const CLAUDE_SETTING_SOURCES = ["user", "project", "local"] as const;
export const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export const CLAUDE_PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
  "auto",
] as const;

/** `runtimes.claude` in the service YAML. */
export const claudeRuntimeConfigSchema = z.strictObject({
  /** Anthropic API key (ANTHROPIC_API_KEY). One of apiKey, authToken or oauthToken is required. */
  apiKey: z.string().optional(),
  /** Bearer token for an LLM gateway (ANTHROPIC_AUTH_TOKEN). */
  authToken: z.string().optional(),
  /** Claude subscription token from `claude setup-token` (CLAUDE_CODE_OAUTH_TOKEN). */
  oauthToken: z.string().optional(),
  /** API endpoint override (ANTHROPIC_BASE_URL). */
  baseUrl: z.string().optional(),
  /** Model used when a project does not set `runtime.model`. */
  model: z.string().optional(),
  /** Root of the per-project config directories (<configDir>/<projectId>); defaults to <dataDir>/claude. */
  configDir: z.string().optional(),
  /** Claude Code executable; defaults to the one bundled with the SDK. */
  executable: z.string().optional(),
  /** Filesystem settings Claude Code loads; "user" is the isolated config directory. */
  settingSources: z.array(z.enum(CLAUDE_SETTING_SOURCES)).optional(),
  /** Built-in tools to enable; defaults to Claude Code's full preset. */
  tools: z.array(z.string()).optional(),
  /**
   * The service runs in an isolated container. Claude Code refuses to skip permission checks
   * as root unless told it is sandboxed (IS_SANDBOX=1); set this to allow it.
   */
  sandboxed: z.boolean().optional(),
  /** Instructions appended to Claude Code's system prompt. */
  appendSystemPrompt: z.string().optional(),
  mcpServers: z.array(mcpServerConfigSchema).optional(),
});

/** The fields of a project's `runtime` section that the Claude runtime reads; others are ignored. */
export const claudeProjectRuntimeSchema = z.object({
  model: z.string().optional(),
  /** Codex-only levels such as "minimal" are ignored rather than rejected. */
  reasoningEffort: z.enum(CLAUDE_EFFORT_LEVELS).optional().catch(undefined),
  approvalPolicy: z.enum(["never", "on-request", "on-failure", "untrusted"]).optional(),
  permissionMode: z.enum(CLAUDE_PERMISSION_MODES).optional(),
  settingSources: z.array(z.enum(CLAUDE_SETTING_SOURCES)).optional(),
  mcpServers: z.array(mcpServerConfigSchema).optional(),
});

export type ClaudeRuntimeConfig = z.output<typeof claudeRuntimeConfigSchema>;
export type ClaudeProjectRuntime = z.output<typeof claudeProjectRuntimeSchema>;
export type ClaudeMcpServer = z.output<typeof mcpServerConfigSchema>;
