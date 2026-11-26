import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { REASONING_EFFORTS, type ProjectVars } from "../domain/types.ts";
import { Logger } from "../observability/logger.ts";
import { extractPromptVarRefs, findMissingProjectVars } from "../prompt/template.ts";
import {
  isPipelineBlueprint,
  isZodObjectSchema,
  toNodeInputJsonSchema,
  type PipelineBlueprint,
  type PipelineNodeSpec,
} from "./sdk.ts";
import type {
  PipelineDefinition,
  PipelineInputSchema,
  PipelineNodeConfig,
  PipelineNodeSnapshot,
  PipelineRunStatus,
} from "./types.ts";

const IDENTIFIER_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;

const notifyStatusSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "waiting_confirmation",
  "failed",
  "completed",
  "cancelled",
]);

const nodeRuntimeSchema = z
  .object({
    type: z.string().trim().min(1).optional(),
    model: z.string().trim().min(1).optional(),
    reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
  })
  .strict();

const DEFAULT_NOTIFY_ON: readonly PipelineRunStatus[] = [
  "waiting_confirmation",
  "failed",
  "completed",
];

/** The fields of each node that a run is bound to; see `PipelineNodeSnapshot`. */
export function toNodesSnapshot(nodes: readonly PipelineNodeConfig[]): PipelineNodeSnapshot[] {
  return nodes.map((n) => ({
    id: n.id,
    name: n.name,
    executor: n.executor,
    terminal: n.terminal,
    gate: n.gate,
    allowPrev: n.allowPrev,
    prevTargets: [...n.prevTargets],
    maxLoops: n.maxLoops,
  }));
}

/** SHA-256 of the node snapshots: a new revision starts exactly when a snapshot field changes. */
export function computeTopologyHash(nodes: readonly PipelineNodeSnapshot[]): string {
  return createHash("sha256").update(JSON.stringify(nodes)).digest("hex");
}

function assertInsideRoot(rootDir: string, resolvedPath: string, label: string): void {
  const rel = path.relative(rootDir, resolvedPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`${label} escapes project directory: ${resolvedPath}`);
  }
}

export interface LoadPipelinesOptions {
  readonly projectId: string;
  readonly projectDir: string;
  readonly projectVars?: ProjectVars | undefined;
  readonly logger?: Logger | undefined;
}

/**
 * Loads and validates all TypeScript pipeline definitions under `<projectDir>/pipelines/*.ts`.
 * Excludes test files (`*.test.ts`), declaration files (`*.d.ts`), and helper subdirectories.
 */
export async function loadProjectPipelines(
  options: LoadPipelinesOptions,
): Promise<PipelineDefinition[]> {
  const pipelinesDir = path.join(options.projectDir, "pipelines");
  if (!existsSync(pipelinesDir)) return [];

  const entries = await readdir(pipelinesDir, { withFileTypes: true });
  const files = entries
    .filter(
      (e) =>
        e.isFile() &&
        e.name.endsWith(".ts") &&
        !e.name.endsWith(".d.ts") &&
        !e.name.endsWith(".test.ts") &&
        !e.name.startsWith("_"),
    )
    .map((e) => path.join(pipelinesDir, e.name))
    .sort();

  const definitions: PipelineDefinition[] = [];
  const seenIds = new Set<string>();

  for (const filePath of files) {
    const def = await loadSinglePipelineFile(filePath, options);
    if (seenIds.has(def.id)) {
      throw new Error(`Duplicate pipeline id "${def.id}" in project ${options.projectId}`);
    }
    seenIds.add(def.id);
    definitions.push(def);
  }

  return definitions;
}

let pipelineModuleImportSeq = 0;

export async function loadSinglePipelineFile(
  filePath: string,
  options: LoadPipelinesOptions,
): Promise<PipelineDefinition> {
  const resolved = path.resolve(filePath);
  const fileStat = await stat(resolved);
  // Bun preserves query-string cache busting on filesystem paths (whereas `file://` URLs strip `?v=`).
  const specifier = `${resolved}?v=${fileStat.mtimeMs}-${++pipelineModuleImportSeq}`;
  const mod = (await import(specifier)) as { default?: unknown };

  if (!isPipelineBlueprint(mod.default)) {
    throw new Error(
      `Pipeline module ${filePath} must default-export a definePipeline(...) blueprint`,
    );
  }

  return compilePipelineBlueprint(mod.default, {
    ...options,
    filePath: resolved,
  });
}

export interface CompilePipelineOptions extends LoadPipelinesOptions {
  readonly filePath: string;
}

/**
 * Validates and compiles an in-memory `PipelineBlueprint` into a runtime `PipelineDefinition`.
 * Used both by the file loader and by tests that construct blueprints directly with `definePipeline`.
 */
export async function compilePipelineBlueprint(
  blueprint: PipelineBlueprint,
  options: CompilePipelineOptions,
): Promise<PipelineDefinition> {
  const { filePath } = options;
  const fallbackId = path.basename(filePath, path.extname(filePath));
  const pipelineId = (blueprint.id ?? fallbackId).trim();
  if (!IDENTIFIER_RE.test(pipelineId)) {
    throw new Error(`Invalid pipeline id "${pipelineId}" in ${filePath}`);
  }

  const name = blueprint.name?.trim();
  if (!name) {
    throw new Error(`Pipeline "${pipelineId}" in ${filePath} requires a non-empty name`);
  }

  if (!Array.isArray(blueprint.nodes) || blueprint.nodes.length < 2) {
    throw new Error(`Pipeline "${pipelineId}" must contain at least 2 nodes`);
  }

  let notifyOn: readonly PipelineRunStatus[] = DEFAULT_NOTIFY_ON;
  if (blueprint.notifyOn !== undefined) {
    const parsedNotify = z.array(notifyStatusSchema).safeParse(blueprint.notifyOn);
    if (!parsedNotify.success) {
      throw new Error(`Pipeline "${pipelineId}" has invalid notifyOn statuses`);
    }
    notifyOn = parsedNotify.data;
  }

  const rawNodes = blueprint.nodes;
  const nodeIndexById = new Map<string, number>();
  for (let i = 0; i < rawNodes.length; i++) {
    const raw = rawNodes[i]!;
    if (!raw.id || !IDENTIFIER_RE.test(raw.id.trim())) {
      throw new Error(`Invalid node id "${raw.id}" in pipeline "${pipelineId}"`);
    }
    const id = raw.id.trim();
    if (nodeIndexById.has(id)) {
      throw new Error(`Duplicate node id "${id}" in pipeline "${pipelineId}"`);
    }
    nodeIndexById.set(id, i);
  }

  const pipelineDir = path.dirname(path.resolve(filePath));
  const projectRoot = path.resolve(options.projectDir);
  const nodes: PipelineNodeConfig[] = [];

  for (let i = 0; i < rawNodes.length; i++) {
    const raw = rawNodes[i]!;
    const id = raw.id.trim();
    const nodeName = raw.name?.trim();
    if (!nodeName) {
      throw new Error(`Pipeline "${pipelineId}" node "${id}" requires a non-empty name`);
    }

    const isLast = i === rawNodes.length - 1;
    const isTerminal = raw.executor === "terminal";

    if (isLast && !isTerminal) {
      throw new Error(
        `Pipeline "${pipelineId}" last node "${id}" must be a terminal node created with node.end(...)`,
      );
    }
    if (!isLast && isTerminal) {
      throw new Error(`Pipeline "${pipelineId}" non-final node "${id}" cannot be terminal`);
    }

    // Validate prevTargets & allowPrev
    const rawAllowPrev = isTerminal ? false : raw.allowPrev;
    const allowPrev = isTerminal ? false : i === 0 ? false : (rawAllowPrev ?? true);
    if (i === 0 && rawAllowPrev === true) {
      throw new Error(`Pipeline "${pipelineId}" first node "${id}" cannot set allowPrev: true`);
    }
    const rawPrevTargets: readonly string[] | undefined =
      raw.executor === "terminal" ? undefined : raw.prevTargets;
    if (i === 0 && rawPrevTargets && rawPrevTargets.length > 0) {
      throw new Error(`Pipeline "${pipelineId}" first node "${id}" cannot define prevTargets`);
    }

    let prevTargets: string[] = [];
    if (allowPrev) {
      if (rawPrevTargets !== undefined) {
        for (const targetId of rawPrevTargets) {
          const targetIdx = nodeIndexById.get(targetId);
          if (targetIdx === undefined) {
            throw new Error(
              `Pipeline "${pipelineId}" node "${id}" prevTarget "${targetId}" does not exist`,
            );
          }
          if (targetIdx >= i) {
            throw new Error(
              `Pipeline "${pipelineId}" node "${id}" prevTarget "${targetId}" must precede "${id}"`,
            );
          }
        }
        prevTargets = Array.from(new Set<string>(rawPrevTargets));
      } else if (i > 0) {
        prevTargets = [rawNodes[i - 1]!.id.trim()];
      }
    }

    // Validate optional Zod input schema
    const rawInput = "input" in raw ? raw.input : undefined;
    let inputSchema: PipelineInputSchema | undefined;
    let inputJsonSchema: Record<string, unknown> | undefined;
    if (rawInput !== undefined) {
      if (!isZodObjectSchema(rawInput)) {
        throw new Error(
          `Pipeline "${pipelineId}" node "${id}" input must be a z.object(...) schema`,
        );
      }
      inputSchema = rawInput;
      inputJsonSchema = toNodeInputJsonSchema(rawInput);
    }

    let promptPath: string | undefined;
    let promptTemplate: string | undefined;
    let handler: PipelineNodeConfig["handler"];
    let runtime: PipelineNodeConfig["runtime"];
    let concurrency = 1;
    let gate: PipelineNodeConfig["gate"] = "auto";
    let timeoutMs: number | undefined;
    let maxLoops = 3;

    if (raw.executor === "agent") {
      if (!raw.prompt?.trim()) {
        throw new Error(`Pipeline "${pipelineId}" agent node "${id}" requires a non-empty prompt`);
      }
      const looksLikePath =
        raw.prompt.startsWith("./") ||
        raw.prompt.startsWith("../") ||
        /\.(md|txt)$/i.test(raw.prompt);
      let resolvedPromptTemplate: string;
      if (looksLikePath) {
        const resolvedPrompt = path.resolve(pipelineDir, raw.prompt);
        assertInsideRoot(projectRoot, resolvedPrompt, `prompt path for node "${id}"`);
        if (!existsSync(resolvedPrompt)) {
          throw new Error(
            `Pipeline "${pipelineId}" node "${id}" prompt file not found: ${resolvedPrompt}`,
          );
        }
        promptPath = resolvedPrompt;
        resolvedPromptTemplate = await readFile(resolvedPrompt, "utf8");
      } else {
        resolvedPromptTemplate = raw.prompt;
      }
      promptTemplate = resolvedPromptTemplate;

      // Static validation: {{ data.xxx }} placeholders must match declared node input schema
      validatePromptDataRefs(pipelineId, id, resolvedPromptTemplate, inputSchema);

      const missingVars = findMissingProjectVars(resolvedPromptTemplate, options.projectVars);
      if (missingVars.length > 0) {
        options.logger?.warn("pipeline node prompt references missing project vars", {
          projectId: options.projectId,
          pipelineId,
          nodeId: id,
          missingVars,
        });
      }

      if (raw.runtime !== undefined) {
        const parsedRuntime = nodeRuntimeSchema.safeParse(raw.runtime);
        if (!parsedRuntime.success) {
          throw new Error(`Pipeline "${pipelineId}" node "${id}" has invalid runtime config`);
        }
        runtime = parsedRuntime.data;
      }
      concurrency = validateConcurrency(pipelineId, id, raw.concurrency ?? 1);
      gate = raw.gate ?? "auto";
      timeoutMs = validateTimeoutMs(pipelineId, id, raw.timeoutMs);
      maxLoops = validateMaxLoops(pipelineId, id, raw.maxLoops ?? 3);
    } else if (raw.executor === "ts") {
      if (typeof raw.run !== "function") {
        throw new Error(`Pipeline "${pipelineId}" code node "${id}" requires a run function`);
      }
      handler = raw.run;
      concurrency = validateConcurrency(pipelineId, id, raw.concurrency ?? 1);
      gate = raw.gate ?? "auto";
      timeoutMs = validateTimeoutMs(pipelineId, id, raw.timeoutMs);
      maxLoops = validateMaxLoops(pipelineId, id, raw.maxLoops ?? 3);
    } else if (raw.executor === "human") {
      gate = "manual";
      maxLoops = validateMaxLoops(pipelineId, id, raw.maxLoops ?? 3);
    }

    nodes.push({
      id,
      name: nodeName,
      executor: raw.executor,
      terminal: isTerminal,
      ...(raw.description !== undefined ? { description: raw.description } : {}),
      ...(promptPath !== undefined ? { promptPath } : {}),
      ...(promptTemplate !== undefined ? { promptTemplate } : {}),
      ...(handler !== undefined ? { handler } : {}),
      ...(inputSchema !== undefined ? { inputSchema } : {}),
      ...(inputJsonSchema !== undefined ? { inputJsonSchema } : {}),
      ...(runtime !== undefined ? { runtime } : {}),
      concurrency,
      gate,
      allowPrev,
      prevTargets,
      maxLoops,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  }

  const snapshot = toNodesSnapshot(nodes);
  const topologyHash = computeTopologyHash(snapshot);

  return {
    projectId: options.projectId,
    id: pipelineId,
    name,
    ...(blueprint.description !== undefined ? { description: blueprint.description } : {}),
    enabled: blueprint.enabled ?? true,
    notifyOn,
    nodes,
    filePath: path.resolve(filePath),
    topologyHash,
  };
}

function validateConcurrency(pipelineId: string, nodeId: string, value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 64) {
    throw new Error(
      `Pipeline "${pipelineId}" node "${nodeId}" concurrency must be an integer between 1 and 64`,
    );
  }
  return value;
}

function validateMaxLoops(pipelineId: string, nodeId: string, value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error(
      `Pipeline "${pipelineId}" node "${nodeId}" maxLoops must be an integer between 1 and 100`,
    );
  }
  return value;
}

function validateTimeoutMs(
  pipelineId: string,
  nodeId: string,
  value: number | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `Pipeline "${pipelineId}" node "${nodeId}" timeoutMs must be a positive integer`,
    );
  }
  return value;
}

/**
 * Statically verifies `{{ data.xxx }}` template references in an agent node prompt against
 * that node's declared Zod `input` schema. Fails fast at load time if a prompt references
 * undeclared data fields without a fallback default.
 */
function validatePromptDataRefs(
  pipelineId: string,
  nodeId: string,
  template: string,
  inputSchema: PipelineInputSchema | undefined,
): void {
  const refs = extractPromptVarRefs(template, ["data"]);
  if (refs.length === 0) return;

  const declaredKeys = inputSchema ? new Set(Object.keys(inputSchema.shape)) : new Set<string>();
  const undeclared: string[] = [];

  for (const ref of refs) {
    if (ref.hasDefault) continue;
    if (!ref.subPath) {
      if (!inputSchema) {
        undeclared.push(ref.path);
      }
      continue;
    }
    const topKey = ref.subPath.split(".")[0]!;
    if (!declaredKeys.has(topKey)) {
      undeclared.push(ref.path);
    }
  }

  if (undeclared.length > 0) {
    const unique = [...new Set(undeclared)].join(", ");
    throw new Error(
      `Pipeline "${pipelineId}" node "${nodeId}" prompt references undeclared data fields (${unique}); declare them in the node's "input" schema or provide a fallback default`,
    );
  }
}
