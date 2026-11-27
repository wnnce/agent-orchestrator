import { createProjectContext, type ProjectContextServices } from "../../src/context/index.ts";
import type { Origin } from "../../src/domain/origin.ts";
import type { ArtifactRecord, ProjectConfig } from "../../src/domain/types.ts";
import { Logger } from "../../src/observability/logger.ts";
import type { PipelineRunRecord } from "../../src/pipeline/types.ts";
import type { ContextOptions, ScopedContext } from "../../src/context/index.ts";

export function testProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    id: "demo",
    displayName: "Demo",
    description: "test",
    routing: { projectId: "demo" },
    ...overrides,
  };
}

/** Project services that do nothing but record what was asked of them. */
export function testContextServices(
  project: ProjectConfig,
  overrides: Partial<ProjectContextServices> = {},
): ProjectContextServices & { notified: unknown[][]; startedSessions: unknown[] } {
  const notified: unknown[][] = [];
  const startedSessions: unknown[] = [];
  return {
    notified,
    startedSessions,
    project,
    logger: new Logger({ sink: () => {} }),
    notifications: {
      queue: async (...args: unknown[]) => {
        notified.push(args);
        return "delivery";
      },
    },
    artifacts: {
      write: async (projectId, origin, turnId, kind, _content, contentType) =>
        ({
          id: "art_test",
          projectId,
          originKind: origin.kind,
          originId: origin.id,
          ...(turnId ? { turnId } : {}),
          kind,
          path: "/dev/null",
          contentType,
          sizeBytes: 0,
          createdAt: new Date().toISOString(),
        }) satisfies ArtifactRecord,
    },
    sessions: {
      start: async (params) => {
        startedSessions.push(params);
        return { sessionId: "ses_started", turnId: "turn_started" };
      },
    },
    pipelines: {
      start: async () => ({ created: true, run: { runId: "run_started" } as PipelineRunRecord }),
      find: async () => null,
      signal: async () => ({ woken: false }),
      list: async () => [],
    },
    ...overrides,
  };
}

/** `createContext` for executors under test, backed by `services`. */
export function contextFactory(
  services: ProjectContextServices,
): (origin: Origin, options: ContextOptions) => ScopedContext {
  return (origin, options) => createProjectContext(services, origin, options);
}
