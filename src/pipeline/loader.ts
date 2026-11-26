import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import YAML from "yaml";
import { z } from "zod";
import { REASONING_EFFORTS, type ProjectVars } from "../domain/types.ts";
import { Logger } from "../observability/logger.ts";
import { findMissingProjectVars } from "../prompt/template.ts";
import type {
  PipelineDefinition,
  PipelineNodeConfig,
  PipelineNodeExecutorType,
  PipelineNodeSnapshot,
  PipelineRunStatus,
  PipelineTsHandler,
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

const rawNodeSchema = z
  .object({
    id: z
      .string()
      .trim()
      .regex(IDENTIFIER_RE, "node id must match /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/"),
    name: z.string().trim().min(1),
    description: z.string().optional(),
    executor: z.enum(["agent", "ts", "human", "terminal"]).optional(),
    terminal: z.boolean().optional(),
    prompt: z.string().trim().min(1).optional(),
    handler: z.string().trim().min(1).optional(),
    runtime: nodeRuntimeSchema.optional(),
    concurrency: z.number().int().min(1).max(64).optional(),
    gate: z.enum(["auto", "manual"]).optional(),
    allowPrev: z.boolean().optional(),
    prevTargets: z.array(z.string().trim().min(1)).optional(),
    maxLoops: z.number().int().min(1).max(100).optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

const rawPipelineSchema = z
  .object({
    id: z
      .string()
      .trim()
      .regex(IDENTIFIER_RE, "pipeline id must match /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/")
      .optional(),
    name: z.string().trim().min(1),
    description: z.string().optional(),
    enabled: z.boolean().optional().default(true),
    notifyOn: z.array(notifyStatusSchema).optional(),
    nodes: z.array(rawNodeSchema).min(2, "pipeline must contain at least 2 nodes"),
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
 * Loads and validates all YAML pipeline definitions under `<projectDir>/pipelines/*.yaml`.
 */
export async function loadProjectPipelines(
  options: LoadPipelinesOptions,
): Promise<PipelineDefinition[]> {
  const pipelinesDir = path.join(options.projectDir, "pipelines");
  if (!existsSync(pipelinesDir)) return [];

  const entries = await readdir(pipelinesDir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && (e.name.endsWith(".yaml") || e.name.endsWith(".yml")))
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

export async function loadSinglePipelineFile(
  filePath: string,
  options: LoadPipelinesOptions,
): Promise<PipelineDefinition> {
  const source = await readFile(filePath, "utf8");
  const doc = YAML.parseDocument(source);
  if (doc.errors.length > 0) {
    throw new Error(`Invalid pipeline YAML ${filePath}: ${doc.errors[0]?.message}`);
  }

  const parsed = rawPipelineSchema.safeParse(doc.toJSON());
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "pipeline"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid pipeline configuration in ${filePath}: ${issues}`);
  }

  const data = parsed.data;
  const fallbackId = path.basename(filePath, path.extname(filePath));
  const pipelineId = data.id ?? fallbackId;
  if (!IDENTIFIER_RE.test(pipelineId)) {
    throw new Error(`Invalid pipeline id "${pipelineId}" in ${filePath}`);
  }

  const rawNodes = data.nodes;
  const nodeIndexById = new Map<string, number>();
  for (let i = 0; i < rawNodes.length; i++) {
    const n = rawNodes[i]!;
    if (nodeIndexById.has(n.id)) {
      throw new Error(`Duplicate node id "${n.id}" in pipeline ${pipelineId}`);
    }
    nodeIndexById.set(n.id, i);
  }

  const pipelineDir = path.dirname(filePath);
  const projectRoot = path.resolve(options.projectDir);
  const nodes: PipelineNodeConfig[] = [];

  for (let i = 0; i < rawNodes.length; i++) {
    const raw = rawNodes[i]!;
    const isLast = i === rawNodes.length - 1;
    const isTerminal = raw.terminal === true || raw.executor === "terminal";

    if (isLast && !isTerminal) {
      throw new Error(
        `Pipeline "${pipelineId}" last node "${raw.id}" must be marked with terminal: true`,
      );
    }
    if (!isLast && isTerminal) {
      throw new Error(`Pipeline "${pipelineId}" non-final node "${raw.id}" cannot be terminal`);
    }

    let executor: PipelineNodeExecutorType;
    if (isTerminal) {
      executor = "terminal";
    } else {
      if (!raw.executor) {
        throw new Error(
          `Pipeline "${pipelineId}" node "${raw.id}" must specify executor ("agent" | "ts" | "human")`,
        );
      }
      executor = raw.executor;
    }

    // Validate prevTargets & allowPrev
    const allowPrev = isTerminal ? false : i === 0 ? false : (raw.allowPrev ?? true);
    if (i === 0 && raw.allowPrev === true) {
      throw new Error(`Pipeline "${pipelineId}" first node "${raw.id}" cannot set allowPrev: true`);
    }
    if (i === 0 && raw.prevTargets && raw.prevTargets.length > 0) {
      throw new Error(`Pipeline "${pipelineId}" first node "${raw.id}" cannot define prevTargets`);
    }

    let prevTargets: string[] = [];
    if (allowPrev) {
      if (raw.prevTargets !== undefined) {
        for (const targetId of raw.prevTargets) {
          const targetIdx = nodeIndexById.get(targetId);
          if (targetIdx === undefined) {
            throw new Error(
              `Pipeline "${pipelineId}" node "${raw.id}" prevTarget "${targetId}" does not exist`,
            );
          }
          if (targetIdx >= i) {
            throw new Error(
              `Pipeline "${pipelineId}" node "${raw.id}" prevTarget "${targetId}" must precede "${raw.id}"`,
            );
          }
        }
        prevTargets = [...new Set(raw.prevTargets)];
      } else if (i > 0) {
        prevTargets = [rawNodes[i - 1]!.id];
      }
    }

    let promptPath: string | undefined;
    let promptTemplate: string | undefined;
    let handlerPath: string | undefined;

    if (executor === "agent") {
      if (!raw.prompt) {
        throw new Error(`Pipeline "${pipelineId}" agent node "${raw.id}" requires a prompt`);
      }
      const looksLikePath =
        raw.prompt.startsWith("./") ||
        raw.prompt.startsWith("../") ||
        /\.(md|txt)$/i.test(raw.prompt);
      if (looksLikePath) {
        const resolved = path.resolve(pipelineDir, raw.prompt);
        assertInsideRoot(projectRoot, resolved, `prompt path for node "${raw.id}"`);
        if (!existsSync(resolved)) {
          throw new Error(
            `Pipeline "${pipelineId}" node "${raw.id}" prompt file not found: ${resolved}`,
          );
        }
        promptPath = resolved;
        promptTemplate = await readFile(resolved, "utf8");
      } else {
        promptTemplate = raw.prompt;
      }

      const missingVars = findMissingProjectVars(promptTemplate, options.projectVars);
      if (missingVars.length > 0) {
        options.logger?.warn("pipeline node prompt references missing project vars", {
          projectId: options.projectId,
          pipelineId,
          nodeId: raw.id,
          missingVars,
        });
      }
    } else if (executor === "ts") {
      if (!raw.handler) {
        throw new Error(`Pipeline "${pipelineId}" ts node "${raw.id}" requires a handler path`);
      }
      const resolved = path.resolve(pipelineDir, raw.handler);
      assertInsideRoot(projectRoot, resolved, `handler path for node "${raw.id}"`);
      if (!existsSync(resolved)) {
        throw new Error(
          `Pipeline "${pipelineId}" node "${raw.id}" handler file not found: ${resolved}`,
        );
      }
      handlerPath = resolved;
    }

    nodes.push({
      id: raw.id,
      name: raw.name,
      executor,
      terminal: isTerminal,
      ...(raw.description !== undefined ? { description: raw.description } : {}),
      ...(promptPath !== undefined ? { promptPath } : {}),
      ...(promptTemplate !== undefined ? { promptTemplate } : {}),
      ...(handlerPath !== undefined ? { handlerPath } : {}),
      ...(raw.runtime !== undefined ? { runtime: raw.runtime } : {}),
      concurrency: isTerminal || executor === "human" ? 0 : (raw.concurrency ?? 2),
      gate: executor === "human" ? "manual" : (raw.gate ?? "auto"),
      allowPrev: allowPrev && prevTargets.length > 0,
      prevTargets,
      maxLoops: raw.maxLoops ?? 3,
      ...(raw.timeoutMs !== undefined ? { timeoutMs: raw.timeoutMs } : {}),
    });
  }

  return {
    projectId: options.projectId,
    id: pipelineId,
    name: data.name,
    ...(data.description !== undefined ? { description: data.description } : {}),
    enabled: data.enabled,
    notifyOn: data.notifyOn ?? DEFAULT_NOTIFY_ON,
    nodes,
    filePath,
    topologyHash: computeTopologyHash(toNodesSnapshot(nodes)),
  };
}

const handlerCache = new Map<string, { mtimeMs: number; handler: PipelineTsHandler }>();

/**
 * Imports a TS pipeline node handler (`export default` or a named `run` export). A handler is
 * imported once per file version: every import of a new URL stays in the module registry, so the
 * file's modification time, not the call, decides when to import again.
 */
export async function loadPipelineTsHandler(handlerPath: string): Promise<PipelineTsHandler> {
  const { mtimeMs } = await stat(handlerPath);
  const cached = handlerCache.get(handlerPath);
  if (cached?.mtimeMs === mtimeMs) return cached.handler;

  const url = `${pathToFileURL(handlerPath).href}?v=${mtimeMs}`;
  const mod = (await import(url)) as Record<string, unknown>;
  const fn = typeof mod.default === "function" ? mod.default : mod.run;
  if (typeof fn !== "function") {
    throw new Error(
      `Pipeline TS handler "${handlerPath}" must export a default function or named "run" function`,
    );
  }
  const handler = fn as PipelineTsHandler;
  handlerCache.set(handlerPath, { mtimeMs, handler });
  return handler;
}
