import type {
  ProjectMetricsData,
  ProjectMetricsRange,
  ProjectOverviewData,
  Store,
} from "../persistence/types.ts";
import type { ProjectManager } from "./manager.ts";
import { TtlSingleflightCache } from "./stats-cache.ts";

export interface ProjectStatsDeps {
  readonly projects: ProjectManager;
  readonly store: Store;
  readonly overviewTtlMs?: number | undefined;
  readonly metricsTtlMs?: number | undefined;
}

/**
 * Project overview and metrics for dashboards. Results are cached briefly so that several
 * open dashboards polling at once share one aggregation query.
 */
export class ProjectStats {
  private readonly overviewCache = new TtlSingleflightCache<ProjectOverviewData>();
  private readonly metricsCache = new TtlSingleflightCache<ProjectMetricsData>();
  private readonly overviewTtlMs: number;
  private readonly metricsTtlMs: number;

  constructor(private readonly deps: ProjectStatsDeps) {
    this.overviewTtlMs = deps.overviewTtlMs ?? 3_000;
    this.metricsTtlMs = deps.metricsTtlMs ?? 20_000;
  }

  /** The project's current state; `refresh` skips the cache. */
  async overview(
    projectId: string,
    options: { limit: number; refresh: boolean },
  ): Promise<ProjectOverviewData> {
    const runtime = this.deps.projects.get(projectId);
    return this.overviewCache.getOrLoad(
      `${projectId}:${options.limit}`,
      this.overviewTtlMs,
      async () => {
        const [snapshot, tasks] = await Promise.all([
          this.deps.store.getProjectOverview(projectId, { limit: options.limit }),
          runtime.tasks.list(),
        ]);
        return {
          generatedAt: new Date().toISOString(),
          ...snapshot,
          tasks: { total: tasks.length, enabled: tasks.filter((task) => task.enabled).length },
        };
      },
      { bypassCache: options.refresh },
    );
  }

  /** Usage and task metrics over `range`, bucketed by day in time zone `tz`. */
  async metrics(
    projectId: string,
    options: { range: ProjectMetricsRange; tz: string; refresh: boolean },
  ): Promise<ProjectMetricsData> {
    this.deps.projects.get(projectId);
    const { range, tz } = options;
    return this.metricsCache.getOrLoad(
      `${projectId}:${range}:${tz}`,
      this.metricsTtlMs,
      () => this.deps.store.getProjectMetrics(projectId, { range, tz }),
      { bypassCache: options.refresh },
    );
  }
}
