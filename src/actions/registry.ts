import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Logger } from "../observability/logger.ts";
import type { Store } from "../persistence/store.ts";
import { createActionContext, type CreateActionContextParams } from "./context.ts";
import type {
  ActionContext,
  ActionDefinition,
  ActionResult,
  ActionScope,
  CodexDynamicToolSpec,
  OpenAIFunctionTool,
} from "./types.ts";

export class ActionRegistry {
  private readonly actions = new Map<string, ActionDefinition<unknown, unknown>>();

  constructor(
    private readonly logger = new Logger(),
    private store?: Store,
  ) {}

  setStore(store: Store): this {
    this.store = store;
    return this;
  }

  /**
   * Register a single modular action.
   */
  register<TParams = unknown, TResult = unknown>(action: ActionDefinition<TParams, TResult>): this {
    if (this.actions.has(action.name)) {
      this.logger.warn("overwriting existing action registration", { action: action.name });
    }
    this.actions.set(action.name, action as unknown as ActionDefinition<unknown, unknown>);
    return this;
  }

  /**
   * Register multiple actions.
   */
  registerAll(actions: readonly ActionDefinition<unknown, unknown>[]): this {
    for (const action of actions) {
      this.register(action);
    }
    return this;
  }

  /**
   * Unregister an action by name.
   */
  unregister(name: string): boolean {
    return this.actions.delete(name);
  }

  /**
   * Get an action definition.
   */
  get(name: string): ActionDefinition<unknown, unknown> | undefined {
    return this.actions.get(name);
  }

  /**
   * Check whether an action exists in registry.
   */
  has(name: string): boolean {
    return this.actions.has(name);
  }

  /**
   * List available actions filtered by scope.
   */
  list(scope: ActionScope = "all"): ActionDefinition<unknown, unknown>[] {
    const all = Array.from(this.actions.values());
    if (scope === "all") return all;
    return all.filter((action) => {
      const scopes = action.scopes ?? ["all"];
      return scopes.includes("all") || scopes.includes(scope);
    });
  }

  /**
   * Export registered actions as Codex App-Server dynamic tools format.
   */
  toCodexTools(scope: ActionScope = "all"): CodexDynamicToolSpec[] {
    return this.list(scope).map((action) => ({
      type: "function" as const,
      name: action.name,
      description: action.description,
      inputSchema: this.toJsonSchema(action.parameters),
    }));
  }

  /**
   * Export registered actions as OpenAI Function Calling tools format.
   */
  toOpenAITools(scope: ActionScope = "all"): OpenAIFunctionTool[] {
    return this.list(scope).map((action) => ({
      type: "function" as const,
      function: {
        name: action.name,
        description: action.description,
        parameters: this.toJsonSchema(action.parameters),
      },
    }));
  }

  /**
   * Unified execution entry point: validate inputs, inject context, execute, and record audit log.
   */
  async execute<T = unknown>(
    name: string,
    rawArgs: unknown,
    context: ActionContext | CreateActionContextParams,
    options?: { readonly parameterOverride?: z.ZodType | Record<string, unknown> | undefined },
  ): Promise<ActionResult<T>> {
    const startTime = Date.now();

    // Ensure context conforms to full ActionContext interface
    const effectiveContext: ActionContext =
      typeof (context as ActionContext).notify === "function"
        ? (context as ActionContext)
        : createActionContext(context);

    const action = this.actions.get(name);
    if (!action) {
      const result: ActionResult<T> = {
        success: false,
        error: `Action "${name}" not found in registry.`,
      };
      this.recordAudit(name, rawArgs, result, effectiveContext, startTime, result.error);
      return result;
    }

    // Parse stringified JSON arguments if provided
    let parsedArgs: unknown = rawArgs;
    if (typeof rawArgs === "string") {
      try {
        parsedArgs = JSON.parse(rawArgs);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const result: ActionResult<T> = {
          success: false,
          error: `Failed to parse arguments JSON for "${name}": ${message}`,
        };
        this.recordAudit(name, rawArgs, result, effectiveContext, startTime, message);
        return result;
      }
    }
    if (parsedArgs === null || parsedArgs === undefined) {
      parsedArgs = {};
    }

    // Validate parameters against Zod schema if available
    let validatedArgs: unknown = parsedArgs;
    const effectiveParameters = options?.parameterOverride ?? action.parameters;
    if (this.isZodType(effectiveParameters)) {
      const result = effectiveParameters.safeParse(parsedArgs);
      if (!result.success) {
        const resultError: ActionResult<T> = {
          success: false,
          error: `Argument validation failed for "${name}": ${result.error.message}`,
        };
        this.recordAudit(name, parsedArgs, resultError, effectiveContext, startTime, resultError.error);
        return resultError;
      }
      validatedArgs = result.data;
    }

    try {
      const data = (await action.handler(validatedArgs, effectiveContext)) as T;
      const resultSuccess: ActionResult<T> = {
        success: true,
        data,
      };
      this.recordAudit(name, validatedArgs, resultSuccess, effectiveContext, startTime);
      return resultSuccess;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const resultError: ActionResult<T> = {
        success: false,
        error: message,
      };
      this.recordAudit(name, validatedArgs, resultError, effectiveContext, startTime, message);
      return resultError;
    }
  }

  private recordAudit(
    actionName: string,
    rawArgs: unknown,
    result: ActionResult<unknown>,
    context: ActionContext,
    startTime: number,
    errorMessage?: string,
  ): void {
    const store = this.store ?? context.service<Store>("store");
    if (!store || typeof store.recordActionExecution !== "function") {
      return;
    }

    const durationMs = Math.max(0, Date.now() - startTime);
    const executionId = `act_${randomUUID()}`;
    const caller = determineCaller(context);
    const safeParameters = sanitizeActionPayload(rawArgs);
    const safeResult = result.success ? sanitizeActionPayload(result.data) : undefined;

    void store
      .recordActionExecution({
        executionId,
        projectId: context.projectId || "unknown",
        sessionId: context.sessionId,
        turnId: context.turnId,
        taskKey: context.taskKey,
        caller,
        actionName,
        parameters:
          typeof safeParameters === "object" && safeParameters !== null && !Array.isArray(safeParameters)
            ? (safeParameters as Record<string, unknown>)
            : { _value: safeParameters },
        status: result.success ? "success" : "failure",
        result: safeResult,
        errorMessage: errorMessage ?? result.error,
        durationMs,
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn("failed to record action execution audit log", {
          action: actionName,
          error: msg,
        });
      });
  }

  private isZodType(param: unknown): param is z.ZodType {
    return (
      typeof param === "object" &&
      param !== null &&
      typeof (param as { safeParse?: unknown }).safeParse === "function"
    );
  }

  private toJsonSchema(param: z.ZodType | Record<string, unknown>): Record<string, unknown> {
    if (this.isZodType(param)) {
      const schema = z.toJSONSchema(param) as Record<string, unknown>;
      const { $schema, ...clean } = schema;
      return clean;
    }
    return param;
  }
}

function determineCaller(context: ActionContext): string {
  if (context.scope === "pipeline") return "pipeline";
  if (context.taskKey) return "task";
  if (context.turnId) return "model";
  if (context.scope === "conversation") return "conversation";
  return "system";
}

export function sanitizeActionPayload(
  value: unknown,
  maxStringLength = 4096,
  maxDepth = 5,
): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (value.length > maxStringLength) {
      return `${value.slice(0, maxStringLength)}... [Truncated ${value.length - maxStringLength} chars]`;
    }
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (value instanceof Uint8Array || (typeof Buffer !== "undefined" && Buffer.isBuffer(value))) {
    return `[Binary data: ${value.byteLength} bytes]`;
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (maxDepth <= 0) return "[Max Depth Reached]";

  if (Array.isArray(value)) {
    const maxItems = 100;
    const items = value
      .slice(0, maxItems)
      .map((item) => sanitizeActionPayload(item, maxStringLength, maxDepth - 1));
    if (value.length > maxItems) {
      items.push(`[Truncated ${value.length - maxItems} items]`);
    }
    return items;
  }

  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    const maxKeys = 100;
    for (let i = 0; i < Math.min(entries.length, maxKeys); i++) {
      const entry = entries[i];
      if (!entry) continue;
      const [k, v] = entry;
      result[k] = sanitizeActionPayload(v, maxStringLength, maxDepth - 1);
    }
    if (entries.length > maxKeys) {
      result["_truncated_keys"] = `[Truncated ${entries.length - maxKeys} keys]`;
    }
    return result;
  }

  return String(value);
}
