import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Logger } from "../observability/logger.ts";
import type { ToolDefinition } from "./types.ts";

const DEFAULT_LOAD_TIMEOUT_MS = 10_000;
const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export interface LoadProjectToolsOptions {
  readonly initTimeoutMs?: number | undefined;
}

/**
 * Determines whether a filename under `projects/<id>/tools/` should be loaded as a tool module.
 * Ignores declaration files (`*.d.ts`), test files (`*.test.ts`, `*.spec.ts`), and
 * underscore-prefixed helper modules (`_*.ts`).
 */
export function isProjectToolFile(fileName: string): boolean {
  if (!fileName.endsWith(".ts")) return false;
  if (fileName.startsWith("_")) return false;
  if (
    fileName.endsWith(".d.ts") ||
    fileName.endsWith(".test.ts") ||
    fileName.endsWith(".spec.ts")
  ) {
    return false;
  }
  return true;
}

function isZodObject(value: unknown): value is z.ZodObject {
  return (
    value instanceof z.ZodObject ||
    (typeof value === "object" &&
      value !== null &&
      typeof (value as { safeParse?: unknown }).safeParse === "function" &&
      "shape" in value)
  );
}

function validateToolDefinition(candidate: unknown, filePath: string): ToolDefinition {
  if (typeof candidate !== "object" || candidate === null) {
    throw new Error(`Expected a defineTool(...) object in ${filePath}`);
  }
  const raw = candidate as Record<string, unknown>;
  if (typeof raw.name !== "string" || !TOOL_NAME_RE.test(raw.name)) {
    throw new Error(
      `Invalid tool name "${String(raw.name ?? "")}" in ${filePath}: must match ${TOOL_NAME_RE}`,
    );
  }
  if (typeof raw.description !== "string" || !raw.description.trim()) {
    throw new Error(`Tool "${raw.name}" in ${filePath} requires a non-empty description`);
  }
  if (!isZodObject(raw.input)) {
    throw new Error(`Tool "${raw.name}" in ${filePath} requires a z.object(...) input schema`);
  }
  if (typeof raw.run !== "function") {
    throw new Error(`Tool "${raw.name}" in ${filePath} requires a run(input, ctx) function`);
  }
  if (raw.when !== undefined && typeof raw.when !== "function") {
    throw new Error(`Tool "${raw.name}" in ${filePath} has a non-function "when" predicate`);
  }
  return candidate as ToolDefinition;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Loads project-scoped custom agent tools from `projects/<projectId>/tools/*.ts`.
 *
 * Each module must default-export a `defineTool(...)` definition or an array of them.
 * Files are loaded in deterministic alphabetical order; malformed files are logged and skipped so
 * one broken tool does not prevent the project from starting. Duplicate names across custom tool
 * files keep the first loaded definition and log a warning.
 */
export async function loadProjectTools(
  projectDir: string,
  projectId: string,
  logger?: Logger,
  options: LoadProjectToolsOptions = {},
): Promise<ToolDefinition[]> {
  const toolsDir = path.join(projectDir, "tools");
  if (!existsSync(toolsDir)) return [];

  const entries = await readdir(toolsDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && isProjectToolFile(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const timeoutMs = options.initTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS;
  const loaded: ToolDefinition[] = [];
  const seen = new Map<string, string>();

  for (const fileName of files) {
    const filePath = path.resolve(toolsDir, fileName);
    try {
      const fileStat = await stat(filePath);
      const specifier = `${filePath}?v=${fileStat.mtimeMs}`;
      const mod = (await withTimeout(
        import(specifier),
        timeoutMs,
        `Loading project tool module ${filePath}`,
      )) as { default?: unknown };

      const exported = mod?.default;
      const items = Array.isArray(exported) ? exported : [exported];
      if (items.length === 0) {
        throw new Error(`Module ${filePath} default-exported an empty tool array`);
      }

      for (const item of items) {
        const tool = validateToolDefinition(item, filePath);
        const existingFile = seen.get(tool.name);
        if (existingFile) {
          logger?.warn("duplicate custom project tool skipped", {
            projectId,
            tool: tool.name,
            existingFile,
            skippedFile: filePath,
          });
          continue;
        }
        seen.set(tool.name, filePath);
        loaded.push(tool);
      }
    } catch (error) {
      logger?.error("failed to load project tool module", {
        projectId,
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return loaded;
}
