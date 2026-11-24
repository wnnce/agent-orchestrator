import type {
  McpServer,
  SessionConfigOption,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
} from "@agentclientprotocol/sdk";
import type { McpServerConfig, ProjectConfig } from "../../domain/types.ts";
import type { RuntimeModelLister } from "../models.ts";
import type { RuntimeCapabilities } from "../runtime.ts";

export interface ACPConfigUpdate {
  configId: string;
  value: string;
}

/**
 * Vendor-specific profile customizing how `ACPRuntime` launches and configures an ACP agent.
 */
export interface ACPProfile {
  readonly name: string;
  readonly type: string;
  readonly description: string;
  readonly capabilities: RuntimeCapabilities;
  /** Fallback reasoning efforts supported by this ACP agent when a model does not declare its own. */
  readonly defaultReasoningEfforts?: readonly string[] | undefined;
  /** Optional model lister implemented by this ACP profile. */
  readonly listModels?: RuntimeModelLister | undefined;

  /** Builds the subprocess command and optional environment overrides. */
  buildCommand(options: { project: ProjectConfig; readOnly: boolean }): {
    command: string[];
    env?: Record<string, string | undefined>;
  };

  /** Maps project `model` / `reasoningEffort` to ACP `session/set_config_option` updates. */
  resolveConfigUpdates?(params: {
    model?: string | undefined;
    reasoningEffort?: string | undefined;
    configOptions: readonly SessionConfigOption[];
  }): ACPConfigUpdate[];

  /** Mode ID requested when `RuntimeContext.readOnly` is true (e.g. `"plan"`). */
  readonly readOnlyModeId?: string | undefined;

  /** Injects project/global `.skills` via `additionalDirectories` when supported by the server. */
  readonly injectSkillsViaAdditionalDirectories?: boolean | undefined;

  /** Slash command sent as a prompt to compact session context (e.g. `"/compact"`). */
  readonly compactCommand?: string | undefined;

  /** Identifies RPC errors meaning the server no longer holds the requested session. */
  isSessionNotFoundError?(error: unknown): boolean;
}

function flattenSelectOptions(option: SessionConfigOption): SessionConfigSelectOption[] {
  if (option.type !== "select") return [];
  const entries = option.options;
  if (entries.length === 0) return [];
  const first = entries[0];
  if (first && "group" in first) {
    return (entries as SessionConfigSelectGroup[]).flatMap((group) => group.options);
  }
  return entries as SessionConfigSelectOption[];
}

function findMatchingOptionValue(option: SessionConfigOption, desired: string): string | undefined {
  const choices = flattenSelectOptions(option);
  if (choices.length === 0) return desired;
  const exact = choices.find((c) => c.value === desired);
  if (exact) return exact.value;
  const normalized = desired.trim().toLowerCase();
  const ci = choices.find(
    (c) => c.value.toLowerCase() === normalized || c.name.toLowerCase() === normalized,
  );
  return ci?.value;
}

/**
 * Default config matcher using standard ACP `configOptions` categories (`model`, `thought_level`).
 */
export function resolveStandardConfigUpdates(params: {
  model?: string | undefined;
  reasoningEffort?: string | undefined;
  configOptions: readonly SessionConfigOption[];
}): ACPConfigUpdate[] {
  const updates: ACPConfigUpdate[] = [];

  if (params.model) {
    const modelOpt = params.configOptions.find(
      (opt) => opt.category === "model" || opt.id === "model",
    );
    if (modelOpt) {
      const value = findMatchingOptionValue(modelOpt, params.model);
      if (value && modelOpt.currentValue !== value) {
        updates.push({ configId: modelOpt.id, value });
      }
    }
  }

  if (params.reasoningEffort) {
    const effortOpt = params.configOptions.find(
      (opt) => opt.category === "thought_level" || opt.id === "thought_level",
    );
    if (effortOpt) {
      const value = findMatchingOptionValue(effortOpt, params.reasoningEffort);
      if (value && effortOpt.currentValue !== value) {
        updates.push({ configId: effortOpt.id, value });
      }
    }
  }

  return updates;
}

/** Converts orchestrator `McpServerConfig` entries into ACP `McpServer` descriptors. */
export function toACPMcpServers(servers: readonly McpServerConfig[]): McpServer[] {
  const result: McpServer[] = [];
  for (const server of servers) {
    if (server.url) {
      const rawHeaders = server.http_headers ?? server.headers ?? {};
      const headers = Object.entries(rawHeaders).map(([name, value]) => ({ name, value }));
      result.push({
        type: "http",
        name: server.name,
        url: server.url,
        headers,
      });
    } else if (server.command) {
      result.push({
        name: server.name,
        command: server.command,
        args: server.args ?? [],
        env: [],
      });
    }
  }
  return result;
}
