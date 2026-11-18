import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { RuntimeContext } from "../runtime.ts";

/**
 * Model definition for Pi Agent, mirroring Pi's models.json model item.
 */
export interface PiModelDefinition {
  id: string;
  name?: string | undefined;
  contextWindow?: number | undefined;
  maxTokens?: number | undefined;
  reasoning?: boolean | undefined;
  input?: ("text" | "image")[] | undefined;
  cost?:
    | {
        input?: number | undefined;
        output?: number | undefined;
        cacheRead?: number | undefined;
        cacheWrite?: number | undefined;
      }
    | undefined;
  compat?: Record<string, unknown> | undefined;
  [key: string]: unknown;
}

/**
 * Provider definition for Pi Agent, mirroring Pi's models.json provider item.
 */
export interface PiProviderConfig {
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  api?: string | undefined;
  headers?: Record<string, string> | undefined;
  models?: PiModelDefinition[] | undefined;
  [key: string]: unknown;
}

/**
 * Configuration options for the in-process Pi Agent runtime adapter.
 */
export interface PiRuntimeConfig {
  /**
   * Default model identifier or pattern (e.g. "deepseek-flash", "deepseek/deepseek-flash").
   */
  defaultModel?: string | undefined;

  /**
   * Default provider identifier (e.g. "deepseek").
   */
  defaultProvider?: string | undefined;

  /**
   * Native Pi Agent providers map, mirroring Pi's models.json providers structure.
   */
  providers?: Record<string, PiProviderConfig> | undefined;

  /**
   * Optional path to an external models.json file to inherit.
   */
  modelsPath?: string | undefined;

  /**
   * LLM Provider identifier for single-provider shorthand.
   */
  provider?: string | undefined;

  /**
   * Model identifier for single-provider shorthand.
   */
  model?: string | undefined;

  /**
   * Provider API Key. Injected in-memory without temporary files on disk.
   */
  apiKey?: string | undefined;

  /**
   * Custom API endpoint URL for OpenAI/Anthropic proxies, gateways, or self-hosted runtimes.
   */
  baseUrl?: string | undefined;

  /**
   * API wire protocol (e.g. "openai-responses", "openai-completions").
   */
  api?: string | undefined;

  /**
   * Optional custom request headers.
   */
  headers?: Record<string, string> | undefined;

  /**
   * Optional explicit model configurations.
   */
  models?: PiModelDefinition[] | undefined;

  /**
   * Model thinking / reasoning effort level.
   */
  thinkingLevel?: ThinkingLevel | undefined;

  /**
   * Allowlist of active tool names (e.g. ["read", "write", "edit", "bash"]).
   */
  tools?: string[] | undefined;

  /**
   * Directory where persistent configuration and sessions reside.
   */
  agentDir?: string | undefined;

  /**
   * Optional custom SettingsManager overrides.
   */
  settings?: Record<string, unknown> | undefined;
}

/**
 * In-memory wrapper tracking a live Pi AgentSession and its turn context.
 */
export interface PiSessionWrapper {
  session: AgentSession;
  sessionId: string;
  workspacePath: string;
  context: RuntimeContext;
  currentTurnId?: string | undefined;
  currentRuntimeTurnId?: string | undefined;
  lastAssistantText?: string | undefined;
  isTurnEnded?: boolean | undefined;
  activeTurnPromise?: Promise<void> | undefined;
  unsubscribe?: (() => void) | undefined;
}
