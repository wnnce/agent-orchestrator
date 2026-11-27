import type { RuntimeAdapter, RuntimeFactoryContext } from "../registry.ts";
import type { ACPProfile } from "./profile.ts";
import { ACPRuntime } from "./runtime.ts";

export { ACPClient, type ACPClientHandlers } from "./client.ts";
export { ACPMcpBridge, ACP_TOOL_SERVER_NAME } from "./mcp-bridge.ts";
export { ACPNormalizer } from "./normalizer.ts";
export {
  resolveStandardConfigUpdates,
  toACPMcpServers,
  type ACPConfigUpdate,
  type ACPProfile,
} from "./profile.ts";
export { ACPRuntime } from "./runtime.ts";
export { prepareACPSkillDirectories } from "./skills.ts";
export { AGY_CAPABILITIES, AGY_PROFILE } from "./profiles/agy.ts";

/**
 * Wraps an `ACPProfile` as a `RuntimeAdapter` for registration in `RuntimeRegistry`.
 */
export function createACPAdapter(profile: ACPProfile): RuntimeAdapter {
  return {
    name: profile.name,
    type: profile.type,
    description: profile.description,
    capabilities: profile.capabilities,
    ...(profile.defaultReasoningEfforts !== undefined
      ? { defaultReasoningEfforts: profile.defaultReasoningEfforts }
      : {}),
    ...(profile.listModels !== undefined ? { listModels: profile.listModels } : {}),
    create: (ctx: RuntimeFactoryContext) =>
      new ACPRuntime(
        profile,
        ctx.logger,
        ctx.globalProject,
        ctx.config.dataDir,
      ),
  };
}
