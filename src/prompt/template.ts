import type { ProjectConfig, ProjectVars } from "../domain/types.ts";
import { resolveCommitter } from "../workspace/workspace.ts";

export interface PromptTemplateVarRef {
  /** Full dot-delimited path, e.g. "vars.githubAuthor". */
  readonly path: string;
  /** Top-level namespace root, e.g. "vars". */
  readonly root: string;
  /** Remaining path after the root (empty string when referencing the root directly, e.g. "state"). */
  readonly subPath: string;
  /** Whether a fallback default was declared via `| <default>`. */
  readonly hasDefault: boolean;
  readonly defaultValue?: string | undefined;
}

export interface RenderPromptResult {
  readonly rendered: string;
  /** Deduplicated list of whitelisted paths that resolved to empty with no declared default. */
  readonly missingVars: readonly string[];
}

export interface ProjectPromptScope {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly repo: {
    readonly baseBranch: string;
    readonly slug: string;
    readonly committerName: string;
    readonly committerEmail: string;
  };
}

export interface NowPromptScope {
  readonly iso: string;
  readonly date: string;
  readonly local: string;
}

const VALID_PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_FORMATTER_CACHE_SIZE = 64;

const dateFormatterCache = new Map<string, Intl.DateTimeFormat>();

interface ParsedExpression {
  readonly path: string;
  readonly root: string;
  readonly subPath: string;
  readonly hasDefault: boolean;
  readonly defaultValue: string;
}

function parsePlaceholderExpression(raw: string): ParsedExpression | null {
  if (raw.includes("\n") || raw.includes("\r")) return null;
  const pipeIdx = raw.indexOf("|");
  const pathRaw = (pipeIdx === -1 ? raw : raw.slice(0, pipeIdx)).trim();
  if (!pathRaw || !VALID_PATH_RE.test(pathRaw)) return null;

  const dotIdx = pathRaw.indexOf(".");
  const root = dotIdx === -1 ? pathRaw : pathRaw.slice(0, dotIdx);
  const subPath = dotIdx === -1 ? "" : pathRaw.slice(dotIdx + 1);
  const hasDefault = pipeIdx !== -1;
  const defaultValue = hasDefault ? raw.slice(pipeIdx + 1).trim() : "";

  return { path: pathRaw, root, subPath, hasDefault, defaultValue };
}

function resolvePathValue(
  scopes: Readonly<Record<string, unknown>>,
  root: string,
  subPath: string,
): unknown {
  if (FORBIDDEN_SEGMENTS.has(root) || !Object.hasOwn(scopes, root)) {
    return undefined;
  }
  let current: unknown = scopes[root];
  if (!subPath) return current;

  let start = 0;
  while (start <= subPath.length) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    const dot = subPath.indexOf(".", start);
    const segment = dot === -1 ? subPath.slice(start) : subPath.slice(start, dot);
    if (FORBIDDEN_SEGMENTS.has(segment) || !Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
    if (dot === -1) break;
    start = dot + 1;
  }
  return current;
}

function stringifyValue(value: unknown, isRootRef: boolean): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object" && value !== null) {
    return isRootRef ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  }
  return "";
}

/**
 * Single-pass O(n) prompt template renderer.
 *
 * Only replaces `{{ path }}` / `{{ path | default }}` expressions whose root namespace
 * exists as an own property of `scopes`. Any unrecognized `{{...}}` (for example code
 * examples inside Markdown fences) is preserved verbatim.
 */
export function renderPromptTemplate(
  template: string,
  scopes: Readonly<Record<string, unknown>>,
): RenderPromptResult {
  if (!template.includes("{{")) {
    return { rendered: template, missingVars: [] };
  }

  let cursor = 0;
  let output = "";
  const missingSet = new Set<string>();
  const len = template.length;

  while (cursor < len) {
    const open = template.indexOf("{{", cursor);
    if (open === -1) {
      output += template.slice(cursor);
      break;
    }

    const close = template.indexOf("}}", open + 2);
    if (close === -1) {
      output += template.slice(cursor);
      break;
    }

    // Jump directly to the innermost "{{" before "}}" so pathological "{{{{...}}" stays O(n).
    const effectiveOpen = template.lastIndexOf("{{", close - 2);
    const rawExpr = template.slice(effectiveOpen + 2, close);
    const parsed = parsePlaceholderExpression(rawExpr);

    if (!parsed || !Object.hasOwn(scopes, parsed.root)) {
      output += template.slice(cursor, close + 2);
      cursor = close + 2;
      continue;
    }

    output += template.slice(cursor, effectiveOpen);
    const resolved = resolvePathValue(scopes, parsed.root, parsed.subPath);
    const isEmpty = resolved === undefined || resolved === null || resolved === "";

    if (isEmpty) {
      if (parsed.hasDefault) {
        output += parsed.defaultValue;
      } else {
        missingSet.add(parsed.path);
      }
    } else {
      output += stringifyValue(resolved, parsed.subPath === "");
    }

    cursor = close + 2;
  }

  return {
    rendered: output,
    missingVars: missingSet.size > 0 ? Array.from(missingSet) : [],
  };
}

/**
 * Statically scans `template` in a single O(n) pass and extracts all valid placeholder references.
 * When `roots` is provided, only references whose root namespace is in `roots` are returned.
 */
export function extractPromptVarRefs(
  template: string,
  roots?: readonly string[],
): PromptTemplateVarRef[] {
  if (!template.includes("{{")) return [];

  const rootFilter = roots ? new Set(roots) : null;
  const refs: PromptTemplateVarRef[] = [];
  let cursor = 0;
  const len = template.length;

  while (cursor < len) {
    const open = template.indexOf("{{", cursor);
    if (open === -1) break;
    const close = template.indexOf("}}", open + 2);
    if (close === -1) break;

    const effectiveOpen = template.lastIndexOf("{{", close - 2);
    const parsed = parsePlaceholderExpression(template.slice(effectiveOpen + 2, close));
    if (parsed && (!rootFilter || rootFilter.has(parsed.root))) {
      refs.push({
        path: parsed.path,
        root: parsed.root,
        subPath: parsed.subPath,
        hasDefault: parsed.hasDefault,
        ...(parsed.hasDefault ? { defaultValue: parsed.defaultValue } : {}),
      });
    }

    cursor = close + 2;
  }

  return refs;
}

/**
 * Returns deduplicated `vars.<key>` paths referenced in `template` that neither declare a
 * fallback default nor exist with a non-empty value in `projectVars`.
 */
export function findMissingProjectVars(template: string, projectVars?: ProjectVars): string[] {
  const refs = extractPromptVarRefs(template, ["vars"]);
  if (refs.length === 0) return [];

  const missing = new Set<string>();
  const varsObj = projectVars ?? {};

  for (const ref of refs) {
    if (ref.hasDefault) continue;
    if (!ref.subPath) continue;
    const val = resolvePathValue({ vars: varsObj }, "vars", ref.subPath);
    if (val === undefined || val === null || val === "") {
      missing.add(ref.path);
    }
  }

  return Array.from(missing);
}

/**
 * Extracts a clean `owner/repo` (or multi-segment GitLab `group/subgroup/repo`) slug from
 * remote Git SSH or HTTPS URLs without leaking credentials or host prefixes.
 */
export function extractRepoSlug(repoUrl?: string): string | undefined {
  if (!repoUrl) return undefined;
  const trimmed = repoUrl.trim();
  if (!trimmed) return undefined;

  let repoPath: string | undefined;

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://") || trimmed.startsWith("ssh://")) {
    try {
      const url = new URL(trimmed);
      repoPath = url.pathname;
    } catch {
      return undefined;
    }
  } else {
    // SCP-like SSH syntax: git@github.com:owner/repo.git
    const scpMatch = trimmed.match(/^[^@\s/]+@[^:\s/]+:(.+)$/);
    if (!scpMatch?.[1]) return undefined;
    repoPath = scpMatch[1];
  }

  const normalized = repoPath
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");

  if (!normalized || !normalized.includes("/")) return undefined;
  return normalized;
}

/**
 * Builds the sanitized `project.*` prompt scope (excludes env, credentials, and repository auth).
 */
export function buildProjectPromptScope(project: ProjectConfig): ProjectPromptScope {
  const committer = resolveCommitter(project.repository);
  return {
    id: project.id,
    displayName: project.displayName,
    description: project.description,
    repo: {
      baseBranch: project.repository?.baseBranch ?? "",
      slug: extractRepoSlug(project.repository?.url) ?? "",
      committerName: committer.name,
      committerEmail: committer.email,
    },
  };
}

function getDateFormatter(timezone: string): Intl.DateTimeFormat {
  const cached = dateFormatterCache.get(timezone);
  if (cached) return cached;

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    const utcCached = dateFormatterCache.get("UTC");
    if (utcCached) return utcCached;
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    timezone = "UTC";
  }

  if (dateFormatterCache.size >= MAX_FORMATTER_CACHE_SIZE) {
    const oldestKey = dateFormatterCache.keys().next().value;
    if (oldestKey !== undefined) dateFormatterCache.delete(oldestKey);
  }
  dateFormatterCache.set(timezone, formatter);
  return formatter;
}

/**
 * Builds the `now.*` prompt scope formatted in the given timezone (defaults to UTC).
 */
export function buildNowPromptScope(timezone?: string, now: Date = new Date()): NowPromptScope {
  const tz = timezone?.trim() || "UTC";
  const formatter = getDateFormatter(tz);
  const parts = formatter.formatToParts(now);

  let year = "0000";
  let month = "00";
  let day = "00";
  let hour = "00";
  let minute = "00";
  let second = "00";

  for (const part of parts) {
    switch (part.type) {
      case "year":
        year = part.value;
        break;
      case "month":
        month = part.value;
        break;
      case "day":
        day = part.value;
        break;
      case "hour":
        hour = part.value === "24" ? "00" : part.value;
        break;
      case "minute":
        minute = part.value;
        break;
      case "second":
        second = part.value;
        break;
    }
  }

  const date = `${year}-${month}-${day}`;
  return {
    iso: now.toISOString(),
    date,
    local: `${date} ${hour}:${minute}:${second}`,
  };
}
