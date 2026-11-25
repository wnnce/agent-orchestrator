import type {
  TaskDefinition,
  TaskExecutionLogLevel,
  TaskExecutionLogRecord,
  TaskExecutionRecord,
} from "../types";
import { http } from "./http";

export interface ListTaskExecutionsParams {
  projectId?: string;
  taskKey?: string;
  status?: "success" | "failed";
  beforeId?: number;
  limit?: number;
}

export interface ListTaskExecutionsResult {
  executions: TaskExecutionRecord[];
  hasMore: boolean;
  nextBeforeId: number | null;
}

export interface ListTaskExecutionLogsParams {
  afterSeq?: number;
  level?: TaskExecutionLogLevel;
  limit?: number;
}

export interface ListTaskExecutionLogsResult {
  logs: TaskExecutionLogRecord[];
  hasMore: boolean;
  nextAfterSeq: number;
}

export const tasksApi = {
  async listByProject(projectId: string): Promise<TaskDefinition[]> {
    const data = await http.get<{ tasks?: TaskDefinition[] }>(
      `/projects/${encodeURIComponent(projectId)}/tasks`,
    );
    return data.tasks ?? [];
  },

  run(
    projectId: string,
    taskId: string,
  ): Promise<{ executionId?: string; status?: string; message?: string; queued?: boolean }> {
    return http.post(
      `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/run`,
    );
  },

  async listExecutions(params?: ListTaskExecutionsParams): Promise<ListTaskExecutionsResult> {
    const data = await http.get<{
      executions?: TaskExecutionRecord[];
      hasMore?: boolean;
      nextBeforeId?: number | null;
    }>("/tasks/executions", {
      projectId: params?.projectId,
      taskKey: params?.taskKey,
      status: params?.status,
      beforeId: params?.beforeId && params.beforeId > 0 ? params.beforeId : undefined,
      limit: params?.limit,
    });
    return {
      executions: data.executions ?? [],
      hasMore: Boolean(data.hasMore),
      nextBeforeId: typeof data.nextBeforeId === "number" ? data.nextBeforeId : null,
    };
  },

  async listExecutionLogs(
    executionId: string,
    params?: ListTaskExecutionLogsParams,
  ): Promise<ListTaskExecutionLogsResult> {
    const data = await http.get<{
      logs?: TaskExecutionLogRecord[];
      hasMore?: boolean;
      nextAfterSeq?: number;
    }>(`/tasks/executions/${encodeURIComponent(executionId)}/logs`, {
      afterSeq: params?.afterSeq && params.afterSeq > 0 ? params.afterSeq : undefined,
      level: params?.level,
      limit: params?.limit,
    });
    return {
      logs: data.logs ?? [],
      hasMore: Boolean(data.hasMore),
      nextAfterSeq: typeof data.nextAfterSeq === "number" ? data.nextAfterSeq : 0,
    };
  },
};
