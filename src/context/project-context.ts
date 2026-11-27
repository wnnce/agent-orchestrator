import type { ProjectConfig } from "../domain/types.ts";
import { type Origin, originLabel, originLogFields, originRef } from "../domain/origin.ts";
import type { ArtifactStore } from "../artifacts/store.ts";
import { type McpClientFactory, ProjectMcpClientPool } from "../mcp/index.ts";
import type { NotificationOutbox } from "../notifications/index.ts";
import type { Logger } from "../observability/logger.ts";
import type {
  PipelineRunRecord,
  PipelineSummaryWithVersions,
  StartPipelineRunParams,
  StartPipelineRunResult,
} from "../pipeline/types.ts";
import {
  buildNowPromptScope,
  buildProjectPromptScope,
  renderPromptTemplate,
} from "../prompt/template.ts";
import type { ProjectContext, StartSessionParams, StartedSession } from "./types.ts";

/** The project services a context is built from. `ProjectRuntime` provides the real ones. */
export interface ProjectContextServices {
  readonly project: ProjectConfig;
  readonly logger: Logger;
  readonly notifications: Pick<NotificationOutbox, "queue">;
  readonly artifacts: Pick<ArtifactStore, "write">;
  readonly sessions: {
    start(params: StartSessionParams, origin: Origin): Promise<StartedSession>;
  };
  readonly pipelines: {
    start(params: StartPipelineRunParams): Promise<StartPipelineRunResult>;
    find(pipelineId: string, externalKey: string): Promise<PipelineRunRecord | null>;
    list(): Promise<PipelineSummaryWithVersions[]>;
    signal(runId: string): Promise<{ woken: boolean }>;
  };
  readonly mcpClientFactory?: McpClientFactory | undefined;
}

export interface ContextOptions {
  readonly signal: AbortSignal;
  /** Replaces the project logger, e.g. with one that also records a task execution's logs. */
  readonly logger?: Logger | undefined;
  /** The origin's own template variables, read at render time (e.g. a task's current state). */
  readonly renderScopes?: (() => Readonly<Record<string, unknown>>) | undefined;
  /** Time zone of the `now` template variable; UTC by default. */
  readonly timezone?: string | undefined;
}

/** A context together with the release of what it opened, such as MCP connections. */
export interface ScopedContext {
  readonly context: ProjectContext;
  dispose(): Promise<void>;
}

/** Builds the one implementation of the project capabilities, attributed to `origin`. */
export function createProjectContext(
  services: ProjectContextServices,
  origin: Origin,
  options: ContextOptions,
): ScopedContext {
  const { project } = services;
  const { signal } = options;
  const logger = (options.logger ?? services.logger).child({
    projectId: project.id,
    ...originLogFields(origin),
  });
  const env = Object.freeze({ ...(project.env ?? {}) });
  const vars = Object.freeze({ ...(project.vars ?? {}) });
  const dir = project.projectDir ?? process.cwd();
  const ref = originRef(origin);

  let mcpPool: ProjectMcpClientPool | undefined;
  const mcp = (): ProjectMcpClientPool => {
    mcpPool ??= new ProjectMcpClientPool({
      servers: project.runtime?.mcpServers ?? [],
      workdir: dir,
      env,
      signal,
      logger,
      ...(services.mcpClientFactory ? { clientFactory: services.mcpClientFactory } : {}),
    });
    return mcpPool;
  };

  const context: ProjectContext = {
    project: { id: project.id, dir, env, vars },
    origin,
    logger,
    signal,

    async notify(message, notifyOptions) {
      signal.throwIfAborted();
      await services.notifications.queue(
        project.id,
        ref,
        project.notifications,
        message,
        notifyOptions,
      );
    },

    artifacts: {
      async create(params) {
        signal.throwIfAborted();
        return services.artifacts.write(
          project.id,
          ref,
          origin.kind === "session" ? origin.turnId : undefined,
          params.kind,
          params.content,
          params.contentType ?? "text/plain",
        );
      },
    },

    mcp: {
      async call(server, tool, args, callOptions) {
        signal.throwIfAborted();
        return mcp().callTool(server, tool, args, callOptions);
      },
      async list(server, callOptions) {
        signal.throwIfAborted();
        return mcp().listTools(server, callOptions);
      },
    },

    sessions: {
      async start(params) {
        signal.throwIfAborted();
        return services.sessions.start(params, origin);
      },
    },

    pipelines: {
      async start(params) {
        signal.throwIfAborted();
        return services.pipelines.start({
          ...params,
          createdBy: params.createdBy ?? originLabel(origin),
        });
      },
      async find(query) {
        signal.throwIfAborted();
        return services.pipelines.find(query.pipelineId, query.externalKey);
      },
      async list() {
        signal.throwIfAborted();
        return services.pipelines.list();
      },
      async signal(query) {
        signal.throwIfAborted();
        if ("runId" in query) return services.pipelines.signal(query.runId);
        const run = await services.pipelines.find(query.pipelineId, query.externalKey);
        if (!run) return { woken: false };
        return services.pipelines.signal(run.runId);
      },
    },

    render(template, extra) {
      return renderPromptTemplate(template, {
        project: buildProjectPromptScope(project),
        vars,
        now: buildNowPromptScope(options.timezone),
        ...(options.renderScopes?.() ?? {}),
        ...(extra ?? {}),
      }).rendered;
    },
  };

  return {
    context,
    async dispose() {
      await mcpPool?.close();
    },
  };
}
