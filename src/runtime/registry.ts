import { fileURLToPath } from "node:url";
import type { AppConfig } from "../config/config.ts";
import type { ProjectConfig } from "../domain/types.ts";
import { Logger } from "../observability/logger.ts";
import type { AgentRuntime, RuntimeCapabilities } from "./runtime.ts";
import { FAKE_CAPABILITIES, FakeRuntime } from "./runtime.ts";
import type { RuntimeModelLister, RuntimeModelOption } from "./models.ts";
import { CODEX_CAPABILITIES, CodexRuntime, createCodexModelLister } from "./codex/index.ts";
import { PI_CAPABILITIES, PiRuntime, createPiModelLister } from "./pi/index.ts";
import { CLAUDE_CAPABILITIES, ClaudeRuntime, listClaudeModels } from "./claude/index.ts";
import { AGY_PROFILE, createACPAdapter } from "./acp/index.ts";

/**
 * Metadata describing a registered runtime and its capabilities.
 */
export interface RuntimeMetadata {
  name: string;
  type: string;
  description?: string | undefined;
  capabilities?: RuntimeCapabilities | undefined;
  /** Fallback reasoning effort levels supported by this runtime when a model does not declare its own. */
  defaultReasoningEfforts?: readonly string[] | undefined;
  /** Marks test/internal runtimes (e.g. `fake`) so UIs can hide them by default. */
  internal?: boolean | undefined;
}

/**
 * Options supplied when registering a runtime.
 */
export interface RuntimeRegistrationOptions {
  description?: string | undefined;
  capabilities?: RuntimeCapabilities | undefined;
  defaultReasoningEfforts?: readonly string[] | undefined;
  internal?: boolean | undefined;
  /** Optional model discovery function owned by this runtime. */
  listModels?: RuntimeModelLister | undefined;
}

/**
 * Context passed to a RuntimeFactory when instantiating an AgentRuntime for a project.
 */
export interface RuntimeFactoryContext {
  project: ProjectConfig;
  logger: Logger;
  config: AppConfig;
  globalProject?: ProjectConfig | undefined;
}

/**
 * Factory function for creating an AgentRuntime instance.
 */
export type RuntimeFactory = (context: RuntimeFactoryContext) => AgentRuntime;

/**
 * Adapter interface for object-based runtime registrations.
 */
export interface RuntimeAdapter {
  readonly name?: string | undefined;
  readonly type?: string | undefined;
  readonly description?: string | undefined;
  readonly capabilities?: RuntimeCapabilities | undefined;
  readonly defaultReasoningEfforts?: readonly string[] | undefined;
  readonly internal?: boolean | undefined;
  readonly listModels?: RuntimeModelLister | undefined;
  create(context: RuntimeFactoryContext): AgentRuntime;
}

/**
 * Registry holding runtime factories/adapters by runtime type identifier.
 */
export class RuntimeRegistry {
  private readonly factories = new Map<string, RuntimeFactory>();
  private readonly metadataMap = new Map<string, RuntimeMetadata>();
  private readonly modelListers = new Map<string, RuntimeModelLister>();

  constructor(private readonly logger = new Logger()) {}

  /**
   * Register a runtime factory function or an adapter instance.
   */
  register(type: string, factory: RuntimeFactory, options?: RuntimeRegistrationOptions): this;
  register(adapter: RuntimeAdapter): this;
  register(
    typeOrAdapter: string | RuntimeAdapter,
    maybeFactory?: RuntimeFactory,
    options?: RuntimeRegistrationOptions,
  ): this {
    if (typeof typeOrAdapter === "string") {
      const name = typeOrAdapter.trim().toLowerCase();
      if (!maybeFactory) {
        throw new Error(`Runtime factory required for type "${typeOrAdapter}"`);
      }
      if (this.factories.has(name)) {
        this.logger.warn("overwriting existing runtime registration", {
          type: name,
        });
      }
      this.factories.set(name, maybeFactory);
      if (options?.listModels) this.modelListers.set(name, options.listModels);
      else this.modelListers.delete(name);
      this.metadataMap.set(name, {
        name,
        type: name,
        description: options?.description,
        capabilities: options?.capabilities,
        ...(options?.defaultReasoningEfforts !== undefined
          ? { defaultReasoningEfforts: options.defaultReasoningEfforts }
          : {}),
        ...(options?.internal ? { internal: true } : {}),
      });
    } else {
      const rawName = typeOrAdapter.name ?? typeOrAdapter.type;
      if (!rawName) {
        throw new Error("RuntimeAdapter must provide a 'name' or 'type'");
      }
      const name = rawName.trim().toLowerCase();
      if (this.factories.has(name)) {
        this.logger.warn("overwriting existing runtime registration", {
          type: name,
        });
      }
      this.factories.set(name, (ctx) => typeOrAdapter.create(ctx));
      if (typeOrAdapter.listModels) this.modelListers.set(name, typeOrAdapter.listModels);
      else this.modelListers.delete(name);
      this.metadataMap.set(name, {
        name,
        type: name,
        description: typeOrAdapter.description,
        capabilities: typeOrAdapter.capabilities,
        ...(typeOrAdapter.defaultReasoningEfforts !== undefined
          ? { defaultReasoningEfforts: typeOrAdapter.defaultReasoningEfforts }
          : {}),
        ...(typeOrAdapter.internal ? { internal: true } : {}),
      });
    }
    return this;
  }

  /**
   * Unregister a runtime by its type identifier.
   */
  unregister(type: string): boolean {
    const key = type.trim().toLowerCase();
    this.metadataMap.delete(key);
    this.modelListers.delete(key);
    return this.factories.delete(key);
  }

  /**
   * Get a registered runtime factory function.
   */
  get(type: string): RuntimeFactory | undefined {
    return this.factories.get(type.trim().toLowerCase());
  }

  /**
   * Check whether a runtime type is registered.
   */
  has(type: string): boolean {
    return this.factories.has(type.trim().toLowerCase());
  }

  /**
   * List all registered runtime type identifiers.
   */
  list(): string[] {
    return [...this.factories.keys()];
  }

  /**
   * List metadata for all registered runtimes.
   */
  listRuntimes(): RuntimeMetadata[] {
    return [...this.metadataMap.values()];
  }

  /**
   * Lists selectable models exposed directly by the specified runtime adapter.
   */
  async listModels(type: string): Promise<readonly RuntimeModelOption[]> {
    const key = type.trim().toLowerCase();
    const lister = this.modelListers.get(key);
    if (!lister) return [];
    return await lister();
  }

  /**
   * Instantiate an AgentRuntime for the specified runtime type.
   */
  create(type: string, context: RuntimeFactoryContext): AgentRuntime {
    const normalized = (type || "").trim().toLowerCase();
    const factory = this.factories.get(normalized);
    if (!factory) {
      const available = this.list().join(", ");
      throw new Error(
        `no runtime adapter registered for project ${context.project.id}: ${type} (available: [${available}])`,
      );
    }
    return factory(context);
  }
}

/**
 * Creates and populates a RuntimeRegistry with the built-in runtimes (fake, codex, pi and claude).
 */
export function createDefaultRuntimeRegistry(logger = new Logger()): RuntimeRegistry {
  const registry = new RuntimeRegistry(logger);

  registry.register("fake", () => new FakeRuntime(), {
    description: "In-memory mock runtime for tests and offline development",
    capabilities: FAKE_CAPABILITIES,
    defaultReasoningEfforts: [],
    internal: true,
  });

  registry.register(
    "codex",
    (ctx) => {
      const codexBinary = fileURLToPath(import.meta.resolve("@openai/codex/bin/codex.js"));
      return new CodexRuntime(codexBinary, ctx.logger, ctx.globalProject);
    },
    {
      description: "OpenAI Codex app-server runtime adapter",
      capabilities: CODEX_CAPABILITIES,
      defaultReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      listModels: createCodexModelLister({ logger }),
    },
  );

  registry.register("pi", (ctx) => new PiRuntime(ctx.logger, ctx.globalProject), {
    description: "Pi Agent native TypeScript SDK in-process runtime adapter",
    capabilities: PI_CAPABILITIES,
    defaultReasoningEfforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    listModels: createPiModelLister({ logger }),
  });

  registry.register(
    "claude",
    (ctx) => new ClaudeRuntime(ctx.logger, ctx.globalProject, ctx.config.dataDir),
    {
      description: "Claude Code runtime adapter (Claude Agent SDK)",
      capabilities: CLAUDE_CAPABILITIES,
      defaultReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      listModels: listClaudeModels,
    },
  );

  registry.register(createACPAdapter(AGY_PROFILE));

  return registry;
}

export const defaultRuntimeRegistry = createDefaultRuntimeRegistry();
