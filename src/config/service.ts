import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { notificationConfigSchema } from "../domain/schemas.ts";
import type { NotificationConfig } from "../domain/types.ts";

const optionalText = z
  .string()
  .trim()
  .transform((value) => value || undefined)
  .optional();

export const serverConfigSchema = z.strictObject({
  host: z.string().trim().min(1).default("0.0.0.0"),
  port: z.number().int().min(1).max(65535).default(7070),
});

export const loggingConfigSchema = z.strictObject({
  level: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export const storageConfigSchema = z.strictObject({
  dataDir: z.string().trim().min(1).default(".data"),
  projectsDir: z.string().trim().min(1).default("projects"),
  artifactDir: z.string().trim().min(1).optional(),
  databaseUrl: optionalText,
});

export const authConfigSchema = z.strictObject({
  token: optionalText,
  allowUnauthenticated: z.boolean().default(true),
});

export const routerConfigSchema = z.strictObject({
  model: optionalText,
  apiKey: optionalText,
  baseUrl: z.url().default("https://api.openai.com/v1"),
});

/** OpenAI-compatible chat model that names sessions; without it titles use the first line. */
export const titlesConfigSchema = z.strictObject({
  model: optionalText,
  apiKey: optionalText,
  baseUrl: z.url().default("https://api.openai.com/v1"),
});

export const feishuConfigSchema = z
  .strictObject({
    enabled: z.boolean().default(false),
    verificationToken: optionalText,
    appId: optionalText,
    appSecret: optionalText,
    apiBaseUrl: optionalText,
  })
  .refine(
    (config) =>
      !config.enabled || !!config.verificationToken || (!!config.appId && !!config.appSecret),
    {
      path: ["verificationToken"],
      message: "verificationToken or (appId and appSecret) is required when Feishu is enabled",
    },
  );

export const wecomConfigSchema = z
  .strictObject({
    enabled: z.boolean().default(false),
    botId: optionalText,
    secret: optionalText,
    wsUrl: optionalText,
  })
  .refine((config) => !config.enabled || (!!config.botId && !!config.secret), {
    path: ["botId"],
    message: "botId and secret are required when WeCom is enabled",
  });

export const channelsConfigSchema = z.strictObject({
  feishu: feishuConfigSchema.prefault({}),
  wecom: wecomConfigSchema.prefault({}),
});

export const hierarchicalAppConfigSchema = z.strictObject({
  /** Runtime for the global project and for projects that do not set runtime.type. */
  defaultRuntime: z.string().min(1).default("codex"),
  server: serverConfigSchema.prefault({}),
  logging: loggingConfigSchema.prefault({}),
  storage: storageConfigSchema.prefault({}),
  auth: authConfigSchema.prefault({}),
  router: routerConfigSchema.prefault({}),
  titles: titlesConfigSchema.prefault({}),
  channels: channelsConfigSchema.prefault({}),
  notifications: z.array(notificationConfigSchema).optional().default([]),
});

/**
 * Normalizes raw YAML document to hierarchical schema while preserving
 * backward compatibility for flat top-level fields.
 */
function normalizeRawConfig(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const obj = { ...(raw as Record<string, any>) };

  // 1. server
  const server = { ...(obj.server ?? {}) };
  if (obj.host !== undefined && server.host === undefined) server.host = obj.host;
  if (obj.port !== undefined && server.port === undefined) server.port = obj.port;
  obj.server = server;
  delete obj.host;
  delete obj.port;

  // 2. logging
  const logging = { ...(obj.logging ?? {}) };
  if (obj.logLevel !== undefined && logging.level === undefined) logging.level = obj.logLevel;
  obj.logging = logging;
  delete obj.logLevel;

  // 3. storage
  const storage = { ...(obj.storage ?? {}) };
  if (obj.dataDir !== undefined && storage.dataDir === undefined) storage.dataDir = obj.dataDir;
  if (obj.projectConfigPath !== undefined && storage.projectsDir === undefined)
    storage.projectsDir = obj.projectConfigPath;
  if (obj.artifactDir !== undefined && storage.artifactDir === undefined)
    storage.artifactDir = obj.artifactDir;
  if (obj.databaseUrl !== undefined && storage.databaseUrl === undefined)
    storage.databaseUrl = obj.databaseUrl;
  obj.storage = storage;
  delete obj.dataDir;
  delete obj.projectConfigPath;
  delete obj.artifactDir;
  delete obj.databaseUrl;

  // 4. auth
  const auth = { ...(obj.auth ?? {}) };
  if (obj.apiToken !== undefined && auth.token === undefined) auth.token = obj.apiToken;
  if (obj.allowUnauthenticated !== undefined && auth.allowUnauthenticated === undefined)
    auth.allowUnauthenticated = obj.allowUnauthenticated;
  obj.auth = auth;
  delete obj.apiToken;
  delete obj.allowUnauthenticated;

  // 5. router
  const router = { ...(obj.router ?? {}) };
  if (obj.routerModel !== undefined && router.model === undefined) router.model = obj.routerModel;
  if (obj.routerApiKey !== undefined && router.apiKey === undefined)
    router.apiKey = obj.routerApiKey;
  if (obj.routerBaseUrl !== undefined && router.baseUrl === undefined)
    router.baseUrl = obj.routerBaseUrl;
  obj.router = router;
  delete obj.routerModel;
  delete obj.routerApiKey;
  delete obj.routerBaseUrl;

  // 6. channels (feishu, wecom)
  const channels = { ...(obj.channels ?? {}) };
  if (obj.feishu !== undefined && channels.feishu === undefined) channels.feishu = obj.feishu;
  if (obj.wecom !== undefined && channels.wecom === undefined) channels.wecom = obj.wecom;
  obj.channels = channels;
  delete obj.feishu;
  delete obj.wecom;

  // 7. notifications: support top-level or channels.notifications fallback
  if (obj.channels?.notifications !== undefined && obj.notifications === undefined) {
    obj.notifications = obj.channels.notifications;
    delete obj.channels.notifications;
  }

  return obj;
}

export const appConfigSchema = z.preprocess(normalizeRawConfig, hierarchicalAppConfigSchema);

export type ServerConfig = z.output<typeof serverConfigSchema>;
export type LoggingConfig = z.output<typeof loggingConfigSchema>;
export type StorageConfig = {
  dataDir: string;
  projectsDir: string;
  artifactDir: string;
  databaseUrl?: string | undefined;
};
export type AuthConfig = z.output<typeof authConfigSchema>;
export type RouterConfig = z.output<typeof routerConfigSchema>;
export type TitlesConfig = z.output<typeof titlesConfigSchema>;
export type FeishuConfig = z.output<typeof feishuConfigSchema>;
export type WeComConfig = z.output<typeof wecomConfigSchema>;

export interface AppConfig {
  /** Runtime for the global project and for projects that do not set runtime.type. */
  defaultRuntime?: string;
  server?: ServerConfig;
  logging?: LoggingConfig;
  storage?: StorageConfig;
  auth?: AuthConfig;
  router?: RouterConfig;
  titles?: TitlesConfig;
  channels?: {
    feishu: FeishuConfig;
    wecom: WeComConfig;
  };
  notifications?: NotificationConfig[] | undefined;

  // Backward-compatible top-level accessors
  host: string;
  port: number;
  logLevel: "debug" | "info" | "warn" | "error";
  dataDir: string;
  artifactDir: string;
  projectConfigPath: string;
  databaseUrl?: string | undefined;
  apiToken?: string | undefined;
  allowUnauthenticated: boolean;
  routerModel?: string | undefined;
  routerApiKey?: string | undefined;
  routerBaseUrl: string;
  feishu: FeishuConfig;
  wecom?: WeComConfig;
}

/**
 * Service configuration has one source: the selected YAML file.
 * Supports hierarchical domain grouping with backward compatibility for legacy top-level keys.
 */
export async function loadConfig(file = "config.yaml"): Promise<AppConfig> {
  const filePath = path.resolve(file);
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Service configuration not found: ${filePath}. Copy config.example.yaml to config.yaml or use --config <path>.`,
      );
    }
    throw error;
  }

  const parsed = YAML.parseDocument(content);
  if (parsed.errors.length > 0) {
    // Do not include YAML source snippets, which can contain credentials.
    throw new Error(`Invalid service YAML: ${filePath} (${parsed.errors[0]?.code})`);
  }
  const result = appConfigSchema.safeParse(parsed.toJSON());
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const p = issue.path.join(".") || "config";
      let aliasNote = "";
      if (p === "logging.level") aliasNote = " (logLevel)";
      else if (p === "server.port") aliasNote = " (port)";
      else if (p === "server.host") aliasNote = " (host)";
      else if (p === "storage.dataDir") aliasNote = " (dataDir)";
      else if (p === "storage.projectsDir") aliasNote = " (projectConfigPath)";
      else if (p === "storage.databaseUrl") aliasNote = " (databaseUrl)";
      else if (p === "auth.token") aliasNote = " (apiToken)";
      else if (p === "auth.allowUnauthenticated") aliasNote = " (allowUnauthenticated)";
      else if (p === "router.model") aliasNote = " (routerModel)";
      else if (p === "router.apiKey") aliasNote = " (routerApiKey)";
      else if (p === "router.baseUrl") aliasNote = " (routerBaseUrl)";
      return `${p}${aliasNote}: ${issue.message}`;
    });
    throw new Error(`Invalid service configuration in ${filePath}: ${issues.join("; ")}`);
  }

  const data = result.data as z.output<typeof hierarchicalAppConfigSchema>;
  const baseDir = path.dirname(filePath);
  const dataDir = path.resolve(baseDir, data.storage.dataDir);
  const artifactDir = data.storage.artifactDir
    ? path.resolve(baseDir, data.storage.artifactDir)
    : path.join(dataDir, "artifacts");
  const projectsDir = path.resolve(baseDir, data.storage.projectsDir);

  const storage: StorageConfig = {
    ...data.storage,
    dataDir,
    artifactDir,
    projectsDir,
  };

  return {
    defaultRuntime: data.defaultRuntime,
    server: data.server,
    logging: data.logging,
    storage,
    auth: data.auth,
    router: data.router,
    titles: data.titles,
    channels: data.channels,

    // Backward-compatible accessors
    host: data.server.host,
    port: data.server.port,
    logLevel: data.logging.level,
    dataDir,
    artifactDir,
    projectConfigPath: projectsDir,
    databaseUrl: data.storage.databaseUrl,
    apiToken: data.auth.token,
    allowUnauthenticated: data.auth.allowUnauthenticated,
    routerModel: data.router.model,
    routerApiKey: data.router.apiKey,
    routerBaseUrl: data.router.baseUrl,
    feishu: data.channels.feishu,
    wecom: data.channels.wecom,
    notifications: data.notifications ?? [],
  };
}

export function configPathFromArgs(args: string[]): string {
  if (args.length === 0) return "config.yaml";
  if (args.length === 2 && (args[0] === "--config" || args[0] === "-c") && args[1]?.trim()) {
    return args[1];
  }
  if (args.length === 1 && args[0]?.startsWith("--config=") && args[0].slice(9).trim()) {
    return args[0].slice(9);
  }
  throw new Error("Usage: bun run src/main.ts [--config <path>]");
}
