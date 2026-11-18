import { z } from "zod";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { RuntimeContext } from "../runtime.ts";

export const PI_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/** A provider entry, mirroring a provider in Pi's models.json. */
export const piProviderConfigSchema = z
  .object({
    baseUrl: z.string().optional(),
    apiKey: z.string().optional(),
    api: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    models: z.array(z.object({ id: z.string() }).passthrough()).optional(),
  })
  .passthrough();

/** `runtimes.pi` in the service YAML. */
export const piRuntimeConfigSchema = z.strictObject({
  /** Provider used when a project names a model without one. */
  defaultProvider: z.string().optional(),
  /** Model used when a project does not set `runtime.model`. */
  defaultModel: z.string().optional(),
  providers: z.record(z.string(), piProviderConfigSchema).optional(),
  thinkingLevel: z.enum(PI_THINKING_LEVELS).optional(),
  /** Built-in tools to enable; defaults to read, write, edit and bash. */
  tools: z.array(z.string()).optional(),
  /** Pi's config directory (models.json, auth.json, sessions); defaults to <dataDir>/pi/<project>. */
  agentDir: z.string().optional(),
  /** Pi settings overrides. */
  settings: z.record(z.string(), z.unknown()).optional(),
});

export type PiProviderConfig = z.output<typeof piProviderConfigSchema>;
export type PiRuntimeConfig = z.output<typeof piRuntimeConfigSchema>;

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
