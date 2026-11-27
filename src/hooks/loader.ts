import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../observability/logger.ts";
import { HOOK_ID_RE, hookSpecSchema, isDefinedHook, type DefinedHook } from "./sdk.ts";

const LOAD_TIMEOUT_MS = 10_000;

/** A hook loaded from a project, under the id it is served at. */
export interface LoadedHook extends DefinedHook {
  readonly id: string;
  readonly filePath: string;
}

/**
 * Whether a file under `projects/<id>/hooks/` is a hook. Underscore-prefixed files are helpers
 * shared between hooks; declaration and test files are skipped too.
 */
export function isHookFile(fileName: string): boolean {
  return (
    fileName.endsWith(".ts") &&
    !fileName.startsWith("_") &&
    !fileName.endsWith(".d.ts") &&
    !fileName.endsWith(".test.ts") &&
    !fileName.endsWith(".spec.ts")
  );
}

/**
 * Loads the hooks in `projects/<id>/hooks/`, in file name order. A file that fails to load is
 * logged and skipped; when two files declare the same id, the first one is kept.
 */
export async function loadProjectHooks(
  projectDir: string,
  projectId: string,
  logger: Logger,
): Promise<Map<string, LoadedHook>> {
  const hooks = new Map<string, LoadedHook>();
  const hooksDir = path.join(projectDir, "hooks");
  if (!existsSync(hooksDir)) return hooks;

  const files = (await readdir(hooksDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && isHookFile(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  for (const fileName of files) {
    const filePath = path.join(hooksDir, fileName);
    try {
      const hook = await loadHookFile(filePath);
      const existing = hooks.get(hook.id);
      if (existing) {
        logger.warn("duplicate project hook skipped", {
          projectId,
          hookId: hook.id,
          existingFile: existing.filePath,
          skippedFile: filePath,
        });
        continue;
      }
      hooks.set(hook.id, hook);
    } catch (error) {
      logger.error("failed to load project hook", {
        projectId,
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return hooks;
}

async function loadHookFile(filePath: string): Promise<LoadedHook> {
  const module = (await withTimeout(import(filePath), LOAD_TIMEOUT_MS, filePath)) as {
    default?: unknown;
  };
  const exported = module.default;
  if (!isDefinedHook(exported)) {
    throw new Error("expected a default export created with defineHook(...)");
  }
  const parsed = hookSpecSchema.safeParse(exported);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  const id = exported.id ?? path.basename(filePath, ".ts");
  if (!HOOK_ID_RE.test(id)) {
    throw new Error(`invalid hook id "${id}"; declare an id matching ${HOOK_ID_RE}`);
  }
  return { ...exported, id, filePath };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  filePath: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`loading ${filePath} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
