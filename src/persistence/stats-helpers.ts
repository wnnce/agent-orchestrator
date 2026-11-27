import type {
  ProjectMetricsDailyPoint,
  ProjectMetricsData,
  ProjectMetricsModelBreakdown,
  ProjectMetricsRange,
  ProjectMetricsSourceBreakdown,
} from "./stats-types.ts";

export interface TurnMetricsBucketRow {
  day: string;
  model: string | null;
  source: string | null;
  externalChannel: string | null;
  turnCount: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export interface TaskMetricsBucketRow {
  day: string;
  status: string;
  count: number;
}

export interface PipelineMetricsBucketRow {
  day: string;
  status: string;
  count: number;
}

export interface SessionSourceBucketRow {
  source: string | null;
  externalChannel: string | null;
  count: number;
}

export function parseMetricsRangeDays(range: ProjectMetricsRange): number {
  switch (range) {
    case "7d":
      return 7;
    case "14d":
      return 14;
    case "30d":
      return 30;
  }
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function resolveTimeZone(tz?: string): string {
  const trimmed = tz?.trim();
  if (!trimmed) return "UTC";
  if (!isValidTimeZone(trimmed)) {
    throw new Error(`invalid timezone: ${trimmed}`);
  }
  return trimmed;
}

export function formatDayInTimeZone(date: Date, tz: string): string {
  // en-CA formats dates deterministically as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/**
 * Builds the inclusive list of `days` calendar date keys (`YYYY-MM-DD`) ending at `now` in `tz`,
 * along with a conservative UTC lower-bound timestamp (`querySince`) safe across time zones & DST.
 */
export function buildDateWindow(
  days: number,
  tz: string,
  now: Date = new Date(),
): { dayKeys: string[]; querySince: Date } {
  const todayStr = formatDayInTimeZone(now, tz);
  const [y, m, d] = todayStr.split("-").map(Number);
  const anchorUtc = Date.UTC(y!, m! - 1, d!);

  const dayKeys: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const dt = new Date(anchorUtc - i * 86_400_000);
    const yyyy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(dt.getUTCDate()).padStart(2, "0");
    dayKeys.push(`${yyyy}-${mm}-${dd}`);
  }

  // Subtract 1 extra day from the earliest UTC midnight so any timezone offset (-12..+14) is covered;
  // exact day membership is filtered in memory via `dayKeys`.
  const querySince = new Date(anchorUtc - days * 86_400_000);
  return { dayKeys, querySince };
}

export function normalizeSessionSource(
  source?: string | null,
  externalChannel?: string | null,
): string {
  const src = source?.trim().toLowerCase() ?? "";
  const channel = externalChannel?.trim().toLowerCase() ?? "";
  if (src === "task") return "task";
  if (src === "pipeline") return "pipeline";
  if (channel) return channel;
  if (!src || src === "unknown" || src === "web" || src === "gateway") return "web";
  return src;
}

export function computePercentage(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

export function computeCacheHitRate(inputTokens: number, cacheReadTokens: number): number | null {
  return computePercentage(cacheReadTokens, inputTokens + cacheReadTokens);
}

/**
 * Single-pass in-memory multi-dimensional rollup over pre-aggregated SQL/Store buckets.
 * Produces zero-filled daily time series, period totals, and model/source breakdowns.
 */
export function buildProjectMetricsFromAggregates(params: {
  range: ProjectMetricsRange;
  days: number;
  tz: string;
  dayKeys: string[];
  now: Date;
  turnRows: readonly TurnMetricsBucketRow[];
  taskRows: readonly TaskMetricsBucketRow[];
  pipelineRows: readonly PipelineMetricsBucketRow[];
  sessionRows: readonly SessionSourceBucketRow[];
}): ProjectMetricsData {
  const { range, days, tz, dayKeys, now, turnRows, taskRows, pipelineRows, sessionRows } = params;

  const dailyMap = new Map<string, ProjectMetricsDailyPoint>();
  for (const date of dayKeys) {
    dailyMap.set(date, {
      date,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      cacheHitRate: null,
      turnCount: 0,
      taskSuccess: 0,
      taskFailed: 0,
      pipelineCompleted: 0,
      pipelineFailed: 0,
    });
  }

  let totalTurnCount = 0;
  let totalInput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalOutput = 0;
  let totalReasoning = 0;
  let totalTokens = 0;

  const modelMap = new Map<
    string,
    {
      turnCount: number;
      inputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      outputTokens: number;
      reasoningTokens: number;
      totalTokens: number;
    }
  >();

  const sourceMap = new Map<
    string,
    { sessionCount: number; turnCount: number; totalTokens: number }
  >();

  const ensureSource = (key: string) => {
    let entry = sourceMap.get(key);
    if (!entry) {
      entry = { sessionCount: 0, turnCount: 0, totalTokens: 0 };
      sourceMap.set(key, entry);
    }
    return entry;
  };

  for (const row of sessionRows) {
    const key = normalizeSessionSource(row.source, row.externalChannel);
    ensureSource(key).sessionCount += row.count;
  }

  for (const row of turnRows) {
    const point = dailyMap.get(row.day);
    if (!point) continue;

    point.turnCount += row.turnCount;
    point.inputTokens += row.inputTokens;
    point.cacheReadTokens += row.cacheReadTokens;
    point.cacheWriteTokens += row.cacheWriteTokens;
    point.outputTokens += row.outputTokens;
    point.reasoningTokens += row.reasoningTokens;
    point.totalTokens += row.totalTokens;

    totalTurnCount += row.turnCount;
    totalInput += row.inputTokens;
    totalCacheRead += row.cacheReadTokens;
    totalCacheWrite += row.cacheWriteTokens;
    totalOutput += row.outputTokens;
    totalReasoning += row.reasoningTokens;
    totalTokens += row.totalTokens;

    const modelKey = row.model?.trim() || "unknown";
    let modelAcc = modelMap.get(modelKey);
    if (!modelAcc) {
      modelAcc = {
        turnCount: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
      };
      modelMap.set(modelKey, modelAcc);
    }
    modelAcc.turnCount += row.turnCount;
    modelAcc.inputTokens += row.inputTokens;
    modelAcc.cacheReadTokens += row.cacheReadTokens;
    modelAcc.cacheWriteTokens += row.cacheWriteTokens;
    modelAcc.outputTokens += row.outputTokens;
    modelAcc.reasoningTokens += row.reasoningTokens;
    modelAcc.totalTokens += row.totalTokens;

    const srcKey = normalizeSessionSource(row.source, row.externalChannel);
    const srcAcc = ensureSource(srcKey);
    srcAcc.turnCount += row.turnCount;
    srcAcc.totalTokens += row.totalTokens;
  }

  let taskSuccess = 0;
  let taskFailed = 0;
  for (const row of taskRows) {
    const point = dailyMap.get(row.day);
    if (!point) continue;
    if (row.status === "success") {
      point.taskSuccess += row.count;
      taskSuccess += row.count;
    } else if (row.status === "failed" || row.status === "timeout") {
      point.taskFailed += row.count;
      taskFailed += row.count;
    }
  }

  let pipelineCompleted = 0;
  let pipelineFailed = 0;
  let pipelineTotal = 0;
  for (const row of pipelineRows) {
    const point = dailyMap.get(row.day);
    if (!point) continue;
    pipelineTotal += row.count;
    if (row.status === "completed") {
      point.pipelineCompleted += row.count;
      pipelineCompleted += row.count;
    } else if (row.status === "failed") {
      point.pipelineFailed += row.count;
      pipelineFailed += row.count;
    }
  }

  const daily: ProjectMetricsDailyPoint[] = dayKeys.map((date) => {
    const point = dailyMap.get(date)!;
    point.cacheHitRate = computeCacheHitRate(point.inputTokens, point.cacheReadTokens);
    return point;
  });

  const byModel: ProjectMetricsModelBreakdown[] = Array.from(modelMap.entries())
    .filter(([, acc]) => acc.totalTokens > 0 || acc.turnCount > 0)
    .map(([model, acc]) => ({
      model,
      ...acc,
      cacheHitRate: computeCacheHitRate(acc.inputTokens, acc.cacheReadTokens),
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens || b.turnCount - a.turnCount);

  const bySource: ProjectMetricsSourceBreakdown[] = Array.from(sourceMap.entries())
    .filter(([, acc]) => acc.totalTokens > 0 || acc.sessionCount > 0 || acc.turnCount > 0)
    .map(([source, acc]) => ({
      source,
      ...acc,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens || b.sessionCount - a.sessionCount);

  const taskTotal = taskSuccess + taskFailed;

  return {
    generatedAt: now.toISOString(),
    range,
    days,
    tz,
    since: dayKeys[0] ?? formatDayInTimeZone(now, tz),
    summary: {
      turnCount: totalTurnCount,
      inputTokens: totalInput,
      cacheReadTokens: totalCacheRead,
      cacheWriteTokens: totalCacheWrite,
      outputTokens: totalOutput,
      reasoningTokens: totalReasoning,
      totalTokens,
      cacheHitRate: computeCacheHitRate(totalInput, totalCacheRead),
      taskSuccess,
      taskFailed,
      taskTotal,
      taskSuccessRate: computePercentage(taskSuccess, taskTotal),
      pipelineCompleted,
      pipelineFailed,
      pipelineTotal,
    },
    daily,
    byModel,
    bySource,
  };
}
