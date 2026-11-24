import { z } from "zod";
import { REASONING_EFFORTS } from "./types.ts";

export const gitIdentitySchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().optional(),
});

export const repoAuthConfigSchema = z.object({
  type: z.enum(["ssh-key", "token"]),
  key: z.string().optional(),
  keyPath: z.string().optional(),
  keyEnv: z.string().optional(),
  keyContent: z.string().optional(),
  keyContentEnv: z.string().optional(),
  token: z.string().optional(),
  tokenEnv: z.string().optional(),
});

/** A project's repository. An empty `url` gives each session a plain directory without git. */
export const repositoryConfigSchema = z.strictObject({
  url: z.string(),
  baseBranch: z.string().min(1),
  /** A local checkout to use as the base repository, relative to the project directory. */
  path: z.string().min(1).optional(),
  auth: repoAuthConfigSchema.optional(),
  committer: gitIdentitySchema.optional(),
});

export const mcpServerConfigSchema = z
  .object({
    name: z.string().min(1),
    url: z.string().url().optional(),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    auth: z.string().min(1).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    http_headers: z.record(z.string(), z.string()).optional(),
    required: z.boolean().optional(),
    startupTimeoutSec: z.number().positive().optional(),
    toolTimeoutSec: z.number().positive().optional(),
    enabledTools: z.array(z.string()).optional(),
    disabledTools: z.array(z.string()).optional(),
    approvalMode: z.enum(["auto", "prompt", "writes", "approve"]).optional(),
  })
  .superRefine((server, ctx) => {
    if (!server.url && !server.command) {
      ctx.addIssue({
        code: "custom",
        message: "MCP server needs url or command",
      });
    }
    if (server.url && server.command) {
      ctx.addIssue({
        code: "custom",
        message: "MCP server cannot use both url and command",
      });
    }
  });

export const routingDescriptionSchema = z.object({
  projectId: z.string().min(1),
  displayName: z.string().optional(),
  summary: z.string().optional(),
  keywords: z.array(z.string()).optional().default([]),
  jiraProjectKeys: z.array(z.string()).optional().default([]),
  routingHints: z.array(z.string()).optional().default([]),
});

export const notificationConfigSchema = z
  .object({
    type: z.string().min(1),
    name: z.string().min(1),
    url: z.string().url().optional(),
    secret: z.string().min(1).optional(),
    botToken: z.string().min(1).optional(),
    chatId: z
      .union([z.string(), z.number()])
      .transform((v) => String(v))
      .optional(),
    enabled: z.boolean().optional(),
  })
  .superRefine((config, ctx) => {
    if (config.enabled === false) return;
    if (["webhook", "feishu", "wecom"].includes(config.type) && !config.url) {
      ctx.addIssue({
        code: "custom",
        message: "network notifications need url",
      });
    }
    if (config.type === "telegram") {
      const hasToken = !!config.botToken || !!config.secret;
      const hasUrl = !!config.url;
      if (!hasToken && !hasUrl) {
        ctx.addIssue({
          code: "custom",
          message: "telegram notification needs botToken (or secret) or url",
        });
      }
    }
  });

export const projectMetaConfigSchema = z.object({
  id: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
    .optional(),
  displayName: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  tags: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
});

export const projectConfigSchema = z
  .preprocess(
    (val) => {
      if (typeof val === "object" && val !== null && !Array.isArray(val)) {
        const obj = { ...(val as Record<string, unknown>) };
        const parent = obj.project as Record<string, unknown> | undefined;
        if (parent && typeof parent === "object" && !Array.isArray(parent)) {
          if (obj.id === undefined && parent.id !== undefined)
            obj.id = parent.id;
          if (obj.displayName === undefined && parent.displayName !== undefined)
            obj.displayName = parent.displayName;
          if (obj.description === undefined && parent.description !== undefined)
            obj.description = parent.description;
          if (obj.tags === undefined && parent.tags !== undefined)
            obj.tags = parent.tags;
          if (obj.enabled === undefined && parent.enabled !== undefined)
            obj.enabled = parent.enabled;
        }
        if (!obj.routing && obj.id) {
          obj.routing = {
            projectId: obj.id,
            displayName: obj.displayName ?? obj.id,
            summary: obj.description ?? obj.displayName ?? obj.id,
          };
        } else if (
          typeof obj.routing === "object" &&
          obj.routing !== null &&
          obj.id
        ) {
          const routing = { ...(obj.routing as Record<string, unknown>) };
          if (!routing.projectId) routing.projectId = obj.id;
          obj.routing = routing;
        }
        return obj;
      }
      return val;
    },
    z.strictObject({
      id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
      revision: z.number().int().positive().optional(),
      displayName: z.string().min(1),
      description: z.string().min(1),
      projectDir: z.string().optional(),
      tags: z.array(z.string()).optional(),
      enabled: z.boolean().optional(),
      project: projectMetaConfigSchema.optional(),
      routing: routingDescriptionSchema,
      runtime: z
        .strictObject({
          type: z.string().min(1).optional(),
          model: z.string().min(1).optional(),
          reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
          mcpServers: z.array(mcpServerConfigSchema).optional(),
        })
        .optional(),
      session: z
        .strictObject({
          idleTimeoutMs: z.number().int().positive().optional(),
          archiveTimeoutMs: z.number().int().positive().optional(),
        })
        .optional(),
      vars: z
        .record(
          z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
          z.union([z.string(), z.number(), z.boolean()]),
        )
        .optional(),
      env: z.record(z.string(), z.string()).optional(),
      repository: repositoryConfigSchema.optional(),
      credentials: z.record(z.string(), z.string()).optional(),
      notifications: z.array(notificationConfigSchema).optional(),
      notifyOnTurnCompleted: z.boolean().optional(),
    }),
  )
  .superRefine((project, ctx) => {
    if (project.routing.projectId !== project.id) {
      ctx.addIssue({
        code: "custom",
        path: ["routing", "projectId"],
        message: "routing.projectId must match id",
      });
    }
  });
