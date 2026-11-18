import { fileURLToPath } from "node:url";
import type { AppConfig, CodexConfig } from "../config/config.ts";
import type { ProjectConfig } from "../domain/types.ts";
import type { ActionRegistry } from "../actions/registry.ts";
import { Logger } from "../observability/logger.ts";
import type { AgentRuntime, RuntimeCapabilities } from "./runtime.ts";
import { FAKE_CAPABILITIES, FakeRuntime } from "./runtime.ts";
import { CODEX_CAPABILITIES, CodexRuntime } from "./codex.ts";

/**
 * Metadata describing a registered runtime and its capabilities.
 */
export interface RuntimeMetadata {
  name: string;
  type: string;
  description?: string | undefined;
  capabilities?: RuntimeCapabilities | undefined;
}

/**
 * Options supplied when registering a runtime.
 */
export interface RuntimeRegistrationOptions {
  description?: string | undefined;
  capabilities?: RuntimeCapabilities | undefined;
}

/**
 * Context passed to a RuntimeFactory when instantiating an AgentRuntime for a project.
 */
export interface RuntimeFactoryContext {
  project: ProjectConfig;
  logger: Logger;
  config: AppConfig;
  actionRegistry?: ActionRegistry | undefined;
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
  create(context: RuntimeFactoryContext): AgentRuntime;
}

/**
 * Registry holding runtime factories/adapters by runtime type identifier.
 */
export class RuntimeRegistry {
  private readonly factories = new Map<string, RuntimeFactory>();
  private readonly metadataMap = new Map<string, RuntimeMetadata>();

  constructor(private readonly logger = new Logger()) {}

  /**
   * Register a runtime factory function or an adapter instance.
   */
  register(
    type: string,
    factory: RuntimeFactory,
    options?: RuntimeRegistrationOptions,
  ): this;
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
      this.metadataMap.set(name, {
        name,
        type: name,
        description: options?.description,
        capabilities: options?.capabilities,
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
      this.metadataMap.set(name, {
        name,
        type: name,
        description: typeOrAdapter.description,
        capabilities: typeOrAdapter.capabilities,
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
 * Creates and populates a RuntimeRegistry with default built-in runtimes (codex and fake).
 */
export function createDefaultRuntimeRegistry(
  logger = new Logger(),
): RuntimeRegistry {
  const registry = new RuntimeRegistry(logger);

  registry.register("fake", () => new FakeRuntime(), {
    description: "In-memory mock runtime for tests and offline development",
    capabilities: FAKE_CAPABILITIES,
  });

  registry.register(
    "codex",
    (ctx) => {
      const codexBinary = fileURLToPath(
        import.meta.resolve("@openai/codex/bin/codex.js"),
      );
      const runtimeConfig = (ctx.config.runtimes?.codex ??
        ctx.config.codex ??
        {}) as CodexConfig;
      return new CodexRuntime(
        codexBinary,
        ctx.logger,
        runtimeConfig,
        ctx.globalProject,
        ctx.actionRegistry,
      );
    },
    {
      description: "OpenAI Codex app-server runtime adapter",
      capabilities: CODEX_CAPABILITIES,
    },
  );

  return registry;
}

export const defaultRuntimeRegistry = createDefaultRuntimeRegistry();
