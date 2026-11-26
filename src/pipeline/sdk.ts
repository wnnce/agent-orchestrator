import { z } from "zod";
import { PipelineValidationError } from "./errors.ts";
import type {
  InferNodeData,
  PipelineInputSchema,
  PipelineNodeGate,
  PipelineNodeRuntimeConfig,
  PipelineRunStatus,
  PipelineTsHandler,
} from "./types.ts";

// =====================================================================
// Typed Pipeline Authoring SDK (`definePipeline`, `defineHandler`, `node.*`)
// =====================================================================

const HANDLER_BRAND = "PipelineTsHandlerSpec" as const;
const BLUEPRINT_BRAND = "PipelineBlueprint" as const;

export interface TsHandlerSpec<
  TInput extends PipelineInputSchema | undefined = PipelineInputSchema | undefined,
> {
  readonly __brand: typeof HANDLER_BRAND;
  readonly input?: TInput;
  readonly run: PipelineTsHandler<InferNodeData<TInput>>;
}

interface CommonNodeSpec {
  readonly id: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly allowPrev?: boolean | undefined;
  readonly prevTargets?: readonly string[] | undefined;
  readonly maxLoops?: number | undefined;
}

export interface AgentNodeSpec extends CommonNodeSpec {
  readonly executor: "agent";
  readonly prompt: string;
  readonly input?: PipelineInputSchema | undefined;
  readonly runtime?: PipelineNodeRuntimeConfig | undefined;
  readonly concurrency?: number | undefined;
  readonly gate?: PipelineNodeGate | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface CodeNodeSpec extends CommonNodeSpec {
  readonly executor: "ts";
  readonly input?: PipelineInputSchema | undefined;
  readonly run: PipelineTsHandler<Record<string, unknown>>;
  readonly concurrency?: number | undefined;
  readonly gate?: PipelineNodeGate | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface HumanNodeSpec extends CommonNodeSpec {
  readonly executor: "human";
  readonly input?: PipelineInputSchema | undefined;
}

export interface TerminalNodeSpec {
  readonly executor: "terminal";
  readonly terminal: true;
  readonly id: string;
  readonly name: string;
  readonly description?: string | undefined;
}

export type PipelineNodeSpec = AgentNodeSpec | CodeNodeSpec | HumanNodeSpec | TerminalNodeSpec;

export interface PipelineBlueprint {
  readonly __brand: typeof BLUEPRINT_BRAND;
  readonly id?: string | undefined;
  readonly name: string;
  readonly description?: string | undefined;
  readonly enabled?: boolean | undefined;
  readonly notifyOn?: readonly PipelineRunStatus[] | undefined;
  readonly nodes: readonly PipelineNodeSpec[];
}

export interface DefinePipelineConfig {
  readonly id?: string | undefined;
  readonly name: string;
  readonly description?: string | undefined;
  readonly enabled?: boolean | undefined;
  readonly notifyOn?: readonly PipelineRunStatus[] | undefined;
  readonly nodes: readonly PipelineNodeSpec[];
}

/**
 * Define a reusable, strongly-typed external code node handler.
 * Pass the returned spec to `node.code({ id, name, handler })`.
 */
export function defineHandler<
  TInput extends PipelineInputSchema | undefined = undefined,
>(spec: {
  readonly input?: TInput;
  readonly run: PipelineTsHandler<InferNodeData<TInput>>;
}): TsHandlerSpec<TInput> {
  return {
    __brand: HANDLER_BRAND,
    ...(spec.input !== undefined ? { input: spec.input } : {}),
    run: spec.run,
  };
}

export function isTsHandlerSpec(value: unknown): value is TsHandlerSpec {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __brand?: unknown }).__brand === HANDLER_BRAND &&
    typeof (value as { run?: unknown }).run === "function"
  );
}

interface CodeNodeBaseConfig extends CommonNodeSpec {
  readonly concurrency?: number | undefined;
  readonly gate?: PipelineNodeGate | undefined;
  readonly timeoutMs?: number | undefined;
}

function createAgentNode<TInput extends PipelineInputSchema | undefined = undefined>(config: {
  readonly id: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly prompt: string;
  readonly input?: TInput;
  readonly runtime?: PipelineNodeRuntimeConfig | undefined;
  readonly concurrency?: number | undefined;
  readonly gate?: PipelineNodeGate | undefined;
  readonly allowPrev?: boolean | undefined;
  readonly prevTargets?: readonly string[] | undefined;
  readonly maxLoops?: number | undefined;
  readonly timeoutMs?: number | undefined;
}): AgentNodeSpec {
  return {
    executor: "agent",
    id: config.id,
    name: config.name,
    prompt: config.prompt,
    ...(config.description !== undefined ? { description: config.description } : {}),
    ...(config.input !== undefined ? { input: config.input } : {}),
    ...(config.runtime !== undefined ? { runtime: config.runtime } : {}),
    ...(config.concurrency !== undefined ? { concurrency: config.concurrency } : {}),
    ...(config.gate !== undefined ? { gate: config.gate } : {}),
    ...(config.allowPrev !== undefined ? { allowPrev: config.allowPrev } : {}),
    ...(config.prevTargets !== undefined ? { prevTargets: config.prevTargets } : {}),
    ...(config.maxLoops !== undefined ? { maxLoops: config.maxLoops } : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
  };
}

function createCodeNode<TInput extends PipelineInputSchema | undefined = undefined>(
  config: CodeNodeBaseConfig & {
    readonly input?: TInput;
    readonly run: PipelineTsHandler<InferNodeData<TInput>>;
    readonly handler?: never;
  },
): CodeNodeSpec;
function createCodeNode<TInput extends PipelineInputSchema | undefined = undefined>(
  config: CodeNodeBaseConfig & {
    readonly handler: TsHandlerSpec<TInput>;
    readonly input?: never;
    readonly run?: never;
  },
): CodeNodeSpec;
function createCodeNode(
  config: CodeNodeBaseConfig & {
    readonly input?: PipelineInputSchema | undefined;
    readonly run?: PipelineTsHandler<Record<string, unknown>> | undefined;
    readonly handler?: TsHandlerSpec | undefined;
  },
): CodeNodeSpec {
  const hasHandler = config.handler !== undefined;
  const hasRun = config.run !== undefined;
  if (hasHandler && hasRun) {
    throw new PipelineValidationError(
      `node.code("${config.id}") cannot specify both "handler" and "run"`,
    );
  }
  if (hasHandler && config.input !== undefined) {
    throw new PipelineValidationError(
      `node.code("${config.id}") cannot specify "input" when using an external "handler" (declare input inside defineHandler instead)`,
    );
  }
  if (hasHandler) {
    if (!isTsHandlerSpec(config.handler)) {
      throw new PipelineValidationError(
        `node.code("${config.id}") "handler" must be created with defineHandler(...)`,
      );
    }
    return {
      executor: "ts",
      id: config.id,
      name: config.name,
      ...(config.description !== undefined ? { description: config.description } : {}),
      ...(config.handler.input !== undefined ? { input: config.handler.input } : {}),
      run: config.handler.run as PipelineTsHandler<Record<string, unknown>>,
      ...(config.concurrency !== undefined ? { concurrency: config.concurrency } : {}),
      ...(config.gate !== undefined ? { gate: config.gate } : {}),
      ...(config.allowPrev !== undefined ? { allowPrev: config.allowPrev } : {}),
      ...(config.prevTargets !== undefined ? { prevTargets: config.prevTargets } : {}),
      ...(config.maxLoops !== undefined ? { maxLoops: config.maxLoops } : {}),
      ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    };
  }
  if (!hasRun) {
    throw new PipelineValidationError(
      `node.code("${config.id}") requires either an inline "run" function or an external "handler"`,
    );
  }
  return {
    executor: "ts",
    id: config.id,
    name: config.name,
    ...(config.description !== undefined ? { description: config.description } : {}),
    ...(config.input !== undefined ? { input: config.input } : {}),
    run: config.run!,
    ...(config.concurrency !== undefined ? { concurrency: config.concurrency } : {}),
    ...(config.gate !== undefined ? { gate: config.gate } : {}),
    ...(config.allowPrev !== undefined ? { allowPrev: config.allowPrev } : {}),
    ...(config.prevTargets !== undefined ? { prevTargets: config.prevTargets } : {}),
    ...(config.maxLoops !== undefined ? { maxLoops: config.maxLoops } : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
  };
}

function createHumanNode<TInput extends PipelineInputSchema | undefined = undefined>(config: {
  readonly id: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly input?: TInput;
  readonly allowPrev?: boolean | undefined;
  readonly prevTargets?: readonly string[] | undefined;
  readonly maxLoops?: number | undefined;
}): HumanNodeSpec {
  return {
    executor: "human",
    id: config.id,
    name: config.name,
    ...(config.description !== undefined ? { description: config.description } : {}),
    ...(config.input !== undefined ? { input: config.input } : {}),
    ...(config.allowPrev !== undefined ? { allowPrev: config.allowPrev } : {}),
    ...(config.prevTargets !== undefined ? { prevTargets: config.prevTargets } : {}),
    ...(config.maxLoops !== undefined ? { maxLoops: config.maxLoops } : {}),
  };
}

function createEndNode(config: {
  readonly id: string;
  readonly name: string;
  readonly description?: string | undefined;
}): TerminalNodeSpec {
  return {
    executor: "terminal",
    terminal: true,
    id: config.id,
    name: config.name,
    ...(config.description !== undefined ? { description: config.description } : {}),
  };
}

/** Node constructors for `definePipeline({ nodes: [...] })`. */
export const node = {
  agent: createAgentNode,
  code: createCodeNode,
  human: createHumanNode,
  end: createEndNode,
} as const;

export function definePipeline(config: DefinePipelineConfig): PipelineBlueprint {
  return {
    __brand: BLUEPRINT_BRAND,
    ...config,
  };
}

export function isPipelineBlueprint(value: unknown): value is PipelineBlueprint {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __brand?: unknown }).__brand === BLUEPRINT_BRAND &&
    Array.isArray((value as { nodes?: unknown }).nodes)
  );
}

// =====================================================================
// Schema Conversion & Runtime Data Validation Helpers
// =====================================================================

export function isZodObjectSchema(value: unknown): value is PipelineInputSchema {
  return value instanceof z.ZodObject;
}

/** Converts a node's Zod input object schema into clean JSON Schema without `$schema`. */
export function toNodeInputJsonSchema(schema: PipelineInputSchema): Record<string, unknown> {
  const raw = z.toJSONSchema(schema) as Record<string, unknown>;
  const { $schema: _ignored, ...clean } = raw;
  return clean;
}

/**
 * Validates and normalizes `data` against a node's declared `inputSchema`.
 * - If the node did NOT declare an `inputSchema`, returns `{}` unconditionally.
 * - If the node declared an `inputSchema`, parses strictly with Zod (applying defaults)
 *   and throws `PipelineValidationError` with field-level details on mismatch.
 */
export function validateNodeInputData(
  nodeId: string,
  schema: PipelineInputSchema | undefined,
  raw: unknown,
): Record<string, unknown> {
  if (!schema) return {};
  const candidate = raw ?? {};
  if (typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new PipelineValidationError(
      `Invalid data for node "${nodeId}": expected a JSON object matching the node's input schema`,
    );
  }
  const parsed = schema.safeParse(candidate);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "data"}: ${issue.message}`)
      .join("; ");
    throw new PipelineValidationError(`Invalid data for node "${nodeId}": ${details}`);
  }
  return parsed.data as Record<string, unknown>;
}
