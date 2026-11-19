import path from "node:path";
import { mkdir, readFile, stat, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { ProjectConfig } from "../domain/types.ts";
import YAML from "yaml";
import { projectConfigSchema } from "../domain/schemas.ts";
import type { AppConfig } from "./service.ts";

export { loadConfig, configPathFromArgs } from "./service.ts";
export type { AppConfig, FeishuConfig, WeComConfig } from "./service.ts";

export function parseDotenv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split(/\r?\n/);
  let currentKey: string | null = null;
  let currentValue = "";
  let inMultiLine = false;
  let quoteChar: string | null = null;

  for (const line of lines) {
    if (!inMultiLine) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const eqIndex = line.indexOf("=");
      if (eqIndex === -1) continue;

      const key = line.slice(0, eqIndex).trim();
      let val = line.slice(eqIndex + 1).trim();

      if (val.startsWith('"') || val.startsWith("'")) {
        const openingQuote = val.startsWith('"') ? '"' : "'";
        quoteChar = openingQuote;
        val = val.slice(1);
        if (
          val.endsWith(openingQuote) &&
          (val.length === 1 || !val.endsWith("\\" + openingQuote))
        ) {
          // Single-line quoted value
          val = val.slice(0, -1);
          if (quoteChar === '"') {
            val = val
              .replace(/\\n/g, "\n")
              .replace(/\\r/g, "\r")
              .replace(/\\t/g, "\t")
              .replace(/\\"/g, '"');
          }
          result[key] = val;
          quoteChar = null;
        } else {
          // Multiline value started
          inMultiLine = true;
          currentKey = key;
          currentValue = val;
        }
      } else {
        const hashIdx = val.indexOf("#");
        if (hashIdx !== -1) {
          val = val.slice(0, hashIdx).trim();
        }
        result[key] = val;
      }
    } else {
      if (line.endsWith(quoteChar!) && !line.endsWith("\\" + quoteChar)) {
        currentValue += "\n" + line.slice(0, -1);
        if (quoteChar === '"') {
          currentValue = currentValue
            .replace(/\\n/g, "\n")
            .replace(/\\r/g, "\r")
            .replace(/\\t/g, "\t")
            .replace(/\\"/g, '"');
        }
        if (currentKey) {
          result[currentKey] = currentValue;
        }
        inMultiLine = false;
        currentKey = null;
        quoteChar = null;
      } else {
        currentValue += "\n" + line;
      }
    }
  }

  return result;
}

export function resolveEnvString(
  input: string,
  envMap: Record<string, string>,
  context = "configuration",
): string {
  return input.replace(/\{env:([A-Za-z0-9_]+)\}/g, (match, varName) => {
    if (varName in envMap && envMap[varName] !== undefined) {
      return envMap[varName];
    }
    if (varName in process.env && process.env[varName] !== undefined) {
      return process.env[varName]!;
    }
    return match;
  });
}

export function interpolateEnv<T>(
  target: T,
  envMap: Record<string, string>,
  context = "configuration",
): T {
  if (typeof target === "string") {
    return resolveEnvString(target, envMap, context) as unknown as T;
  }
  if (Array.isArray(target)) {
    return target.map((item, idx) =>
      interpolateEnv(item, envMap, `${context}[${idx}]`),
    ) as unknown as T;
  }
  if (typeof target === "object" && target !== null) {
    const res: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(target)) {
      res[k] = interpolateEnv(v, envMap, `${context}.${k}`);
    }
    return res as unknown as T;
  }
  return target;
}

export async function loadDotenvFile(envPath: string): Promise<Record<string, string>> {
  if (!existsSync(envPath)) return {};
  try {
    const raw = await readFile(envPath, "utf8");
    return parseDotenv(raw);
  } catch (error) {
    console.warn(`[config] Failed to load .env from ${envPath}:`, error);
    return {};
  }
}

function normalizeProjectRaw(
  raw: Record<string, unknown>,
  fallbackId: string,
): Record<string, unknown> | null {
  const p = { ...raw };
  const parent = (p.project ?? p.meta ?? p.metadata ?? p.info) as Record<string, unknown> | undefined;
  if (parent && typeof parent === "object" && !Array.isArray(parent)) {
    if (p.id === undefined && parent.id !== undefined) p.id = parent.id;
    if (p.displayName === undefined && parent.displayName !== undefined) p.displayName = parent.displayName;
    if (p.description === undefined && parent.description !== undefined) p.description = parent.description;
    if (p.tags === undefined && parent.tags !== undefined) p.tags = parent.tags;
    if (p.enabled === undefined && parent.enabled !== undefined) p.enabled = parent.enabled;
  }

  // Check enabled flag. If explicitly false, project is disabled and should not be scanned/loaded
  if (p.enabled === false) {
    return null;
  }
  if (parent && parent.enabled === false) {
    return null;
  }

  if (!p.id) p.id = fallbackId;
  if (!p.displayName) p.displayName = p.id;
  if (!p.description) p.description = p.displayName;

  return p;
}

function parseProjectYaml(
  parsed: unknown,
  projectDir: string,
  fallbackId: string,
  projectEnv: Record<string, string> = {},
): ProjectConfig[] {
  const attachEnv = (p: Record<string, unknown>) => {
    if (!p.projectDir) p.projectDir = projectDir;
    if (Object.keys(projectEnv).length > 0) {
      p.env = { ...projectEnv, ...((p.env as Record<string, string>) ?? {}) };
    }
  };

  const prepareProject = (item: Record<string, unknown>): ProjectConfig | null => {
    const p = normalizeProjectRaw(item, fallbackId);
    if (!p) return null;
    attachEnv(p);
    if (!p.routing) {
      p.routing = {
        projectId: p.id,
        displayName: p.displayName,
        summary: p.description,
      };
    } else if (typeof p.routing === "object" && p.routing !== null) {
      const routing = p.routing as Record<string, unknown>;
      if (!routing.projectId) routing.projectId = p.id;
    }
    return projectConfigSchema.parse(p) as ProjectConfig;
  };

  if (Array.isArray(parsed)) {
    const list: ProjectConfig[] = [];
    for (const item of parsed) {
      if (typeof item === "object" && item !== null) {
        const project = prepareProject(item as Record<string, unknown>);
        if (project) list.push(project);
      }
    }
    return list;
  }

  if (typeof parsed === "object" && parsed !== null) {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.projects)) {
      const list: ProjectConfig[] = [];
      for (const item of obj.projects) {
        if (typeof item === "object" && item !== null) {
          const project = prepareProject(item as Record<string, unknown>);
          if (project) list.push(project);
        }
      }
      return list;
    }

    // Single project object (e.g. project.yaml inside a project directory)
    const project = prepareProject(obj);
    return project ? [project] : [];
  }

  throw new Error("Invalid project YAML format");
}

async function loadProjectsFromDirectory(dir: string): Promise<ProjectConfig[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const projects: ProjectConfig[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const projectDir = path.join(dir, entry.name);
      const projectEnv = await loadDotenvFile(path.join(projectDir, ".env"));
      const candidates = [
        "project.yaml",
        "project.yml",
        "config.yaml",
        "config.yml",
        `${entry.name}.yaml`,
        `${entry.name}.yml`,
      ];
      for (const candidate of candidates) {
        const filePath = path.join(projectDir, candidate);
        try {
          const raw = await readFile(filePath, "utf8");
          let parsed: unknown = YAML.parse(raw);
          parsed = interpolateEnv(parsed, projectEnv, `${entry.name}/${candidate}`);
          const projectList = parseProjectYaml(parsed, projectDir, entry.name, projectEnv);
          projects.push(...projectList);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
      }
    } else if (
      entry.isFile() &&
      (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml")) &&
      !entry.name.toLowerCase().startsWith("taskfile")
    ) {
      const projectEnv = await loadDotenvFile(path.join(dir, ".env"));
      const filePath = path.join(dir, entry.name);
      const raw = await readFile(filePath, "utf8");
      let parsed: unknown = YAML.parse(raw);
      parsed = interpolateEnv(parsed, projectEnv, entry.name);
      const baseName = entry.name.replace(/\.ya?ml$/, "");
      const projectList = parseProjectYaml(parsed, dir, baseName, projectEnv);
      projects.push(...projectList);
    }
  }

  return projects;
}

export async function loadProjects(fileOrDir: string): Promise<ProjectConfig[]> {
  try {
    const stats = await stat(fileOrDir);
    if (stats.isDirectory()) {
      return await loadProjectsFromDirectory(fileOrDir);
    }
    const projectDir = path.dirname(fileOrDir);
    const projectEnv = await loadDotenvFile(path.join(projectDir, ".env"));
    const raw = await readFile(fileOrDir, "utf8");
    let parsed: unknown = YAML.parse(raw);
    parsed = interpolateEnv(parsed, projectEnv, path.basename(fileOrDir));
    const baseName = path.basename(fileOrDir).replace(/\.ya?ml$/, "");
    return parseProjectYaml(parsed, projectDir, baseName, projectEnv);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function prepareDirectories(config: AppConfig): Promise<void> {
  await Promise.all([
    mkdir(config.dataDir, { recursive: true }),
    mkdir(config.artifactDir, { recursive: true }),
  ]);
}
