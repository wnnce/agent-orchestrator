import type {
  PipelineActionName,
  PipelineActionRecord,
  PipelineNodeLogRecord,
  PipelineRunDetail,
  PipelineRunRecord,
  PipelineRunStatus,
  PipelineStreamEvent,
  PipelineStreamEventType,
  PipelineSummaryWithVersions,
  TaskExecutionLogLevel,
} from "../types";
import { buildApiUrl, http } from "./http";

export interface ListPipelineRunsParams {
  status?: PipelineRunStatus;
  version?: number;
  nodeId?: string;
  limit?: number;
  beforeId?: number;
}

export interface StartPipelineRunParams {
  title: string;
  description?: string;
  externalKey?: string;
  externalUrl?: string;
  data?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  createdBy?: string;
}

export interface StartPipelineRunResult {
  created: boolean;
  run: PipelineRunRecord;
}

export interface ListPipelineActionsParams {
  nodeId?: string;
  action?: PipelineActionName;
  afterSeq?: number;
  limit?: number;
}

export interface ListPipelineNodeLogsParams {
  afterSeq?: number;
  limit?: number;
  level?: TaskExecutionLogLevel;
}

export interface SubscribePipelineEventsFilter {
  pipelineId?: string;
  runId?: string;
}

const PIPELINE_STREAM_EVENT_TYPES: readonly PipelineStreamEventType[] = [
  "pipeline.run.created",
  "pipeline.run.updated",
  "pipeline.node.updated",
  "pipeline.action.recorded",
  "pipeline.run.completed",
  "pipeline.run.cancelled",
];

export const pipelinesApi = {
  async listPipelines(projectId: string): Promise<PipelineSummaryWithVersions[]> {
    const data = await http.get<{
      projectId: string;
      pipelines?: PipelineSummaryWithVersions[];
    }>(`/projects/${encodeURIComponent(projectId)}/pipelines`);
    return data.pipelines ?? [];
  },

  async listRuns(
    projectId: string,
    pipelineId: string,
    params?: ListPipelineRunsParams,
  ): Promise<PipelineRunRecord[]> {
    const data = await http.get<{
      projectId: string;
      pipelineId: string;
      runs?: PipelineRunRecord[];
    }>(
      `/projects/${encodeURIComponent(projectId)}/pipelines/${encodeURIComponent(pipelineId)}/runs`,
      params
        ? {
            status: params.status,
            version: params.version,
            nodeId: params.nodeId,
            limit: params.limit,
            beforeId: params.beforeId,
          }
        : undefined,
    );
    return data.runs ?? [];
  },

  startRun(
    projectId: string,
    pipelineId: string,
    params: StartPipelineRunParams,
  ): Promise<StartPipelineRunResult> {
    return http.post(
      `/projects/${encodeURIComponent(projectId)}/pipelines/${encodeURIComponent(pipelineId)}/runs`,
      params,
    );
  },

  getRunDetail(runId: string): Promise<PipelineRunDetail> {
    return http.get(`/pipeline-runs/${encodeURIComponent(runId)}`);
  },

  async listRunActions(
    runId: string,
    params?: ListPipelineActionsParams,
  ): Promise<PipelineActionRecord[]> {
    const data = await http.get<{
      runId: string;
      actions?: PipelineActionRecord[];
    }>(
      `/pipeline-runs/${encodeURIComponent(runId)}/actions`,
      params
        ? {
            nodeId: params.nodeId,
            action: params.action,
            afterSeq: params.afterSeq,
            limit: params.limit,
          }
        : undefined,
    );
    return data.actions ?? [];
  },

  async approveRun(
    runId: string,
    params?: {
      humanNote?: string;
      data?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
      actorId?: string;
    },
  ): Promise<PipelineRunRecord> {
    const data = await http.post<{ run: PipelineRunRecord }>(
      `/pipeline-runs/${encodeURIComponent(runId)}/approve`,
      params ?? {},
    );
    return data.run;
  },

  async rejectRun(
    runId: string,
    params: {
      reason: string;
      feedback: string;
      targetNodeId?: string;
      data?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
      actorId?: string;
    },
  ): Promise<PipelineRunRecord> {
    const data = await http.post<{ run: PipelineRunRecord }>(
      `/pipeline-runs/${encodeURIComponent(runId)}/reject`,
      params,
    );
    return data.run;
  },

  async retryRun(
    runId: string,
    params?: { preserveStepState?: boolean; actorId?: string },
  ): Promise<PipelineRunRecord> {
    const data = await http.post<{ run: PipelineRunRecord }>(
      `/pipeline-runs/${encodeURIComponent(runId)}/retry`,
      params ?? {},
    );
    return data.run;
  },

  async cancelRun(
    runId: string,
    params?: { reason?: string; actorId?: string },
  ): Promise<PipelineRunRecord> {
    const data = await http.post<{ run: PipelineRunRecord }>(
      `/pipeline-runs/${encodeURIComponent(runId)}/cancel`,
      params ?? {},
    );
    return data.run;
  },

  signalRun(runId: string): Promise<{ woken: boolean; run: PipelineRunRecord }> {
    return http.post(`/pipeline-runs/${encodeURIComponent(runId)}/signal`);
  },

  async listNodeRunLogs(
    nodeRunId: string,
    params?: ListPipelineNodeLogsParams,
  ): Promise<PipelineNodeLogRecord[]> {
    const data = await http.get<{
      nodeRunId: string;
      logs?: PipelineNodeLogRecord[];
    }>(
      `/pipeline-node-runs/${encodeURIComponent(nodeRunId)}/logs`,
      params
        ? {
            afterSeq: params.afterSeq,
            limit: params.limit,
            level: params.level,
          }
        : undefined,
    );
    return data.logs ?? [];
  },

  subscribeEvents(
    projectId: string,
    onEvent: (event: PipelineStreamEvent) => void,
    filter?: SubscribePipelineEventsFilter,
    onConnectionChange?: (connected: boolean) => void,
  ): () => void {
    let es: EventSource | null = null;
    let closed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    function handleMessage(e: MessageEvent) {
      try {
        const parsed = JSON.parse(e.data) as PipelineStreamEvent;
        if (parsed && typeof parsed.type === "string" && typeof parsed.runId === "string") {
          onEvent(parsed);
        }
      } catch (err) {
        console.warn("Failed to parse pipeline SSE event:", err, e.data);
      }
    }

    function connect() {
      if (closed) return;
      const url = buildApiUrl(`/projects/${encodeURIComponent(projectId)}/pipeline-events`, {
        pipelineId: filter?.pipelineId,
        runId: filter?.runId,
      });
      es = new EventSource(url);

      es.addEventListener("connected", () => {
        onConnectionChange?.(true);
      });

      for (const eventType of PIPELINE_STREAM_EVENT_TYPES) {
        es.addEventListener(eventType, handleMessage);
      }

      es.onerror = () => {
        onConnectionChange?.(false);
        es?.close();
        es = null;
        if (!closed) {
          retryTimer = setTimeout(connect, 2500);
        }
      };
    }

    connect();

    return () => {
      closed = true;
      onConnectionChange?.(false);
      if (retryTimer) clearTimeout(retryTimer);
      es?.close();
      es = null;
    };
  },
};
