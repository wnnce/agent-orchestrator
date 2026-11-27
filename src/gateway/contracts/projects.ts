import { createRoute, z } from "@hono/zod-openapi";
import { REASONING_EFFORTS } from "../../domain/types.ts";
import { isValidTimeZone } from "../../persistence/stats-helpers.ts";
import {
  badRequestResponse,
  jsonContent,
  notFoundResponse,
  projectIdParamSchema,
} from "./common.ts";

export const projectRoutingSchema = z
  .object({
    projectId: z.string(),
    displayName: z.string().optional(),
    summary: z.string().optional(),
    keywords: z.array(z.string()).readonly().optional(),
    jiraProjectKeys: z.array(z.string()).readonly().optional(),
    routingHints: z.array(z.string()).readonly().optional(),
  })
  .openapi("ProjectRouting");

export const projectSummarySchema = projectRoutingSchema
  .extend({
    repository: z.string().optional().openapi({ description: "Configured repository URL" }),
    runtime: z.object({
      type: z.string(),
      model: z.string().optional(),
      reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
    }),
  })
  .openapi("ProjectSummary");

export const projectSkillSchema = z
  .object({
    id: z.string().optional(),
    name: z.string(),
    description: z.string().optional(),
    dirPath: z.string().optional(),
    skillFilePath: z.string().optional(),
    path: z.string().optional(),
    source: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("ProjectSkill");

const projectOverviewSessionItemSchema = z.object({
  sessionId: z.string(),
  title: z.string().optional(),
  status: z.enum(["active", "idle", "suspended", "closing", "closed", "archived", "failed"]),
  source: z.string().optional(),
  externalChannel: z.string().optional(),
  runtime: z.string().optional(),
  model: z.string().optional(),
  lastActiveAt: z.string(),
});

const projectOverviewPipelineRunItemSchema = z.object({
  runId: z.string(),
  pipelineId: z.string(),
  pipelineVersion: z.number().int(),
  title: z.string(),
  currentNodeId: z.string(),
  status: z.enum([
    "queued",
    "running",
    "waiting",
    "waiting_confirmation",
    "completed",
    "failed",
    "cancelled",
  ]),
  statusSummary: z.string().optional(),
  updatedAt: z.string(),
  createdAt: z.string(),
});

const projectOverviewPipelineNodeItemSchema = z.object({
  nodeRunId: z.string(),
  runId: z.string(),
  pipelineId: z.string(),
  runTitle: z.string().optional(),
  nodeId: z.string(),
  executorType: z.enum(["agent", "ts", "human", "terminal"]),
  status: z.enum([
    "queued",
    "running",
    "waiting",
    "waiting_confirmation",
    "completed",
    "failed",
    "cancelled",
  ]),
  startedAt: z.string().optional(),
  nextPollAt: z.string().optional(),
  updatedAt: z.string(),
});

const projectOverviewTaskFailureItemSchema = z.object({
  executionId: z.string(),
  taskId: z.string(),
  taskKey: z.string(),
  status: z.enum(["success", "failed", "skipped_overlapping", "timeout"]),
  errorMessage: z.string().optional(),
  startedAt: z.string().optional(),
  durationMs: z.number().optional(),
});

const projectOverviewScheduledJobItemSchema = z.object({
  jobId: z.string(),
  sessionId: z.string(),
  name: z.string(),
  triggerAt: z.string(),
  delayMinutes: z.number().int(),
});

export const projectOverviewSchema = z
  .object({
    generatedAt: z.string(),
    sessions: z.object({
      active: z.number().int(),
      idle: z.number().int(),
      suspended: z.number().int(),
      archived: z.number().int(),
      total: z.number().int(),
    }),
    pipelines: z.object({
      running: z.number().int(),
      waiting: z.number().int(),
      waitingConfirmation: z.number().int(),
      failed: z.number().int(),
      completed: z.number().int(),
      cancelled: z.number().int(),
      total: z.number().int(),
    }),
    tasks: z.object({
      total: z.number().int(),
      enabled: z.number().int(),
    }),
    scheduledJobs: z.object({
      pending: z.number().int(),
    }),
    attention: z.object({
      waitingConfirmations: z.array(projectOverviewPipelineRunItemSchema),
      failedPipelineRuns: z.array(projectOverviewPipelineRunItemSchema),
      failedTaskExecutions: z.array(projectOverviewTaskFailureItemSchema),
    }),
    live: z.object({
      activeSessions: z.array(projectOverviewSessionItemSchema),
      activePipelineNodes: z.array(projectOverviewPipelineNodeItemSchema),
      upcomingJobs: z.array(projectOverviewScheduledJobItemSchema),
    }),
  })
  .openapi("ProjectOverview");

const projectMetricsDailyPointSchema = z.object({
  date: z.string(),
  inputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  outputTokens: z.number(),
  reasoningTokens: z.number(),
  totalTokens: z.number(),
  cacheHitRate: z.number().nullable(),
  turnCount: z.number().int(),
  taskSuccess: z.number().int(),
  taskFailed: z.number().int(),
  pipelineCompleted: z.number().int(),
  pipelineFailed: z.number().int(),
});

const projectMetricsModelBreakdownSchema = z.object({
  model: z.string(),
  turnCount: z.number().int(),
  inputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  outputTokens: z.number(),
  reasoningTokens: z.number(),
  totalTokens: z.number(),
  cacheHitRate: z.number().nullable(),
});

const projectMetricsSourceBreakdownSchema = z.object({
  source: z.string(),
  sessionCount: z.number().int(),
  turnCount: z.number().int(),
  totalTokens: z.number(),
});

export const projectMetricsSchema = z
  .object({
    generatedAt: z.string(),
    range: z.enum(["7d", "14d", "30d"]),
    days: z.number().int(),
    tz: z.string(),
    since: z.string(),
    summary: z.object({
      turnCount: z.number().int(),
      inputTokens: z.number(),
      cacheReadTokens: z.number(),
      cacheWriteTokens: z.number(),
      outputTokens: z.number(),
      reasoningTokens: z.number(),
      totalTokens: z.number(),
      cacheHitRate: z.number().nullable(),
      taskSuccess: z.number().int(),
      taskFailed: z.number().int(),
      taskTotal: z.number().int(),
      taskSuccessRate: z.number().nullable(),
      pipelineCompleted: z.number().int(),
      pipelineFailed: z.number().int(),
      pipelineTotal: z.number().int(),
    }),
    daily: z.array(projectMetricsDailyPointSchema),
    byModel: z.array(projectMetricsModelBreakdownSchema),
    bySource: z.array(projectMetricsSourceBreakdownSchema),
  })
  .openapi("ProjectMetrics");

export const listProjectsRoute = createRoute({
  method: "get",
  path: "/projects",
  tags: ["Projects"],
  summary: "List managed projects",
  responses: {
    200: jsonContent(
      z.object({ projects: z.array(projectSummarySchema) }),
      "List of configured projects",
    ),
  },
});

export const listProjectSkillsRoute = createRoute({
  method: "get",
  path: "/projects/{projectId}/skills",
  tags: ["Projects"],
  summary: "List available skills for a project",
  request: {
    params: projectIdParamSchema,
  },
  responses: {
    200: jsonContent(
      z.object({ projectId: z.string(), skills: z.array(projectSkillSchema) }),
      "Skills discovered for the project",
    ),
    404: notFoundResponse,
  },
});

export const getProjectOverviewRoute = createRoute({
  method: "get",
  path: "/projects/{projectId}/overview",
  tags: ["Projects"],
  summary: "Get live operational overview for a project",
  request: {
    params: projectIdParamSchema,
    query: z.object({
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .openapi({ description: "Preview items per section" }),
      refresh: z
        .enum(["true", "false", "1", "0"])
        .optional()
        .openapi({ description: "Set true/1 to bypass short-lived server cache" }),
    }),
  },
  responses: {
    200: jsonContent(
      projectOverviewSchema,
      "Live project status counts, attention items, and active work",
    ),
    400: badRequestResponse,
    404: notFoundResponse,
  },
});

export const getProjectMetricsRoute = createRoute({
  method: "get",
  path: "/projects/{projectId}/metrics",
  tags: ["Projects"],
  summary: "Get time-series metrics and usage breakdowns for a project",
  request: {
    params: projectIdParamSchema,
    query: z.object({
      range: z.enum(["7d", "14d", "30d"]).default("7d"),
      tz: z
        .string()
        .max(64)
        .optional()
        .refine((value) => !value || isValidTimeZone(value.trim()), {
          message: "Invalid IANA time zone",
        }),
      refresh: z
        .enum(["true", "false", "1", "0"])
        .optional()
        .openapi({ description: "Set true/1 to bypass short-lived server cache" }),
    }),
  },
  responses: {
    200: jsonContent(
      projectMetricsSchema,
      "Aggregated daily metrics, token usage, and model/source breakdowns",
    ),
    400: badRequestResponse,
    404: notFoundResponse,
  },
});
