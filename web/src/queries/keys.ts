export const queryKeys = {
  systemReady: ["system", "ready"] as const,
  projects: ["projects"] as const,
  runtimes: ["runtimes"] as const,
  projectSkills: (projectId: string) => ["projects", projectId, "skills"] as const,

  sessions: (projectId: string) => ["projects", projectId, "sessions"] as const,
  sessionDetail: (sessionId: string) => ["sessions", sessionId, "detail"] as const,
  sessionEvents: (sessionId: string) => ["sessions", sessionId, "events"] as const,
  sessionArtifacts: (sessionId: string) => ["sessions", sessionId, "artifacts"] as const,
  sessionJobs: (sessionId: string) => ["sessions", sessionId, "jobs"] as const,

  scheduledJobs: (projectId: string, status: number | "all") =>
    ["projects", projectId, "jobs", status] as const,
  scheduledJobsAll: (projectId?: string) =>
    projectId ? (["projects", projectId, "jobs"] as const) : (["jobs"] as const),

  pipelines: (projectId: string) => ["projects", projectId, "pipelines"] as const,
  pipelineRunsScope: (projectId: string, pipelineId: string) =>
    ["projects", projectId, "pipelines", pipelineId, "runs"] as const,
  pipelineRuns: (projectId: string, pipelineId: string, version: number) =>
    ["projects", projectId, "pipelines", pipelineId, "runs", version] as const,
  pipelineRun: (runId: string) => ["pipeline-runs", runId] as const,
  pipelineRunActions: (runId: string) => ["pipeline-runs", runId, "actions"] as const,
  pipelineNodeLogs: (nodeRunId: string) => ["pipeline-node-runs", nodeRunId, "logs"] as const,

  tasks: (projectId: string) => ["projects", projectId, "tasks"] as const,
  taskExecutions: (projectId: string, taskId: string) =>
    ["projects", projectId, "tasks", taskId, "executions"] as const,
  taskExecutionsFiltered: (
    projectId: string,
    taskId: string,
    status: "all" | "success" | "failed",
  ) => ["projects", projectId, "tasks", taskId, "executions", status] as const,
  taskExecutionLogs: (executionId: string) => ["task-executions", executionId, "logs"] as const,
  taskExecutionLogsFiltered: (executionId: string, level: string) =>
    ["task-executions", executionId, "logs", level] as const,
} as const;
