import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import type { Logger } from "../observability/logger.ts";

/** Lenient optional trimmed string: coerces null/blank/invalid values to `undefined`. */
export const optionalTrimmedString = z
  .string()
  .trim()
  .transform((v) => v || undefined)
  .nullish()
  .transform((v) => v ?? undefined)
  .catch(undefined);

/** Lenient optional positive integer: coerces numeric strings/floats and drops invalid values. */
export const optionalPositiveInt = z.coerce
  .number()
  .finite()
  .positive()
  .transform((v) => Math.trunc(v))
  .nullish()
  .transform((v) => v ?? undefined)
  .catch(undefined);

/** Lenient effort entry: accepts `"high"` or `{ effort: "high" }`. */
export const effortValueSchema = z.union([
  z.string().trim().min(1),
  z.object({ effort: z.string().trim().min(1) }).transform((v) => v.effort),
]);

/** One selectable model exposed by a runtime along with its supported reasoning efforts. */
export interface RuntimeModelOption {
  /** Model identifier passed to the runtime (e.g. "gpt-5.6-terra", "deepseek/deepseek-v4-pro"). */
  readonly id: string;
  /** Human-readable display name. */
  readonly displayName: string;
  /** Supported reasoning/thinking effort levels for this model (empty when unsupported). */
  readonly reasoningEfforts: readonly string[];
  /** Default reasoning effort for this model, if declared. */
  readonly defaultReasoningEffort?: string | undefined;
  /** Context window limit in tokens, if declared. */
  readonly contextWindow?: number | undefined;
}

/** Function implemented by each runtime adapter to expose its own selectable models. */
export type RuntimeModelLister = () =>
  | Promise<readonly RuntimeModelOption[]>
  | readonly RuntimeModelOption[];

/** Deduplicates and trims a list of reasoning effort identifiers. */
export function uniqueEfforts(efforts: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const effort of efforts) {
    const trimmed = effort.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  return result;
}

interface CachedEntry {
  readonly mtimeMs: number;
  readonly size: number;
  readonly data: unknown;
}

/**
 * Lightweight mtime+size cached JSON file reader shared by runtime model listers and catalog storage.
 * Returns `undefined` when the file does not exist or cannot be parsed.
 */
export class CachedJsonFile {
  private readonly cache = new Map<string, CachedEntry>();

  constructor(private readonly logger?: Logger | undefined) {}

  async read(filePath: string): Promise<unknown> {
    try {
      const info = await stat(filePath);
      const cached = this.cache.get(filePath);
      if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
        return cached.data;
      }
      const text = await readFile(filePath, "utf8");
      const data = JSON.parse(text) as unknown;
      this.cache.set(filePath, { mtimeMs: info.mtimeMs, size: info.size, data });
      return data;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      this.cache.delete(filePath);
      if (code !== "ENOENT") {
        this.logger?.warn("failed to read json file", {
          filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return undefined;
    }
  }
}
