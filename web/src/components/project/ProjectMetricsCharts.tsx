import React, { useMemo, useState } from "react";
import { BarChart3, Layers } from "lucide-react";
import { useTheme } from "../../context/ThemeContext";
import type { ProjectMetricsData } from "../../types";
import { formatTokenCount } from "../../utils/formatters";
import { EChart, type EChartOption } from "../common/EChart";

interface ProjectMetricsChartsProps {
  metrics: ProjectMetricsData;
}

const SOURCE_LABEL: Record<string, string> = {
  web: "Web",
  feishu: "飞书",
  wecom: "企业微信",
  task: "Task",
  pipeline: "Pipeline",
};

function formatShortDate(isoDay: string): string {
  // YYYY-MM-DD -> MM/DD
  const parts = isoDay.split("-");
  return parts.length === 3 ? `${parts[1]}/${parts[2]}` : isoDay;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export default function ProjectMetricsCharts({ metrics }: ProjectMetricsChartsProps) {
  const { theme } = useTheme();
  const isLight = theme === "light";
  const [breakdownTab, setBreakdownTab] = useState<"model" | "source">("model");

  const palette = useMemo(
    () => ({
      textMuted: isLight ? "#666666" : "#8a8a8a",
      textPrimary: isLight ? "#111111" : "#ededed",
      splitLine: isLight ? "rgba(0, 0, 0, 0.06)" : "rgba(255, 255, 255, 0.07)",
      axisLine: isLight ? "rgba(0, 0, 0, 0.12)" : "rgba(255, 255, 255, 0.12)",
      tooltipBg: isLight ? "#ffffff" : "#111111",
      tooltipBorder: isLight ? "#e5e5e5" : "#2a2a2a",
      cacheRead: "#10b981",
      input: "#6366f1",
      output: "#f59e0b",
      hitRate: isLight ? "#0891b2" : "#22d3ee",
      taskOk: "#10b981",
      pipelineOk: "#6366f1",
      failed: "#ef4444",
    }),
    [isLight],
  );

  const hasTokenActivity = metrics.summary.totalTokens > 0 || metrics.summary.turnCount > 0;
  const hasAutomationActivity =
    metrics.summary.taskTotal > 0 ||
    metrics.summary.pipelineCompleted > 0 ||
    metrics.summary.pipelineFailed > 0;

  // Chart 1: Daily Token Usage (Stacked Bar) + Cache Hit Rate (Line)
  const tokenTrendOption = useMemo<EChartOption>(() => {
    const labels = metrics.daily.map((d) => formatShortDate(d.date));
    return {
      animationDuration: 300,
      tooltip: {
        trigger: "axis",
        backgroundColor: palette.tooltipBg,
        borderColor: palette.tooltipBorder,
        borderWidth: 1,
        textStyle: { color: palette.textPrimary, fontSize: 11, fontFamily: "monospace" },
        formatter: (params: unknown) => {
          const list = Array.isArray(params) ? params : [];
          const idx = (list[0] as { dataIndex?: number } | undefined)?.dataIndex ?? 0;
          const point = metrics.daily[idx];
          if (!point) return "";
          const hitText = point.cacheHitRate !== null ? `${point.cacheHitRate}%` : "-";
          return [
            `<div style="font-weight:600;margin-bottom:4px">${escapeHtml(point.date)} · ${point.turnCount} turns</div>`,
            `<div>Total: <b>${formatTokenCount(point.totalTokens)}</b></div>`,
            `<div><span style="color:${palette.cacheRead}">●</span> Cache Read: ${formatTokenCount(point.cacheReadTokens)}</div>`,
            `<div><span style="color:${palette.input}">●</span> Uncached In: ${formatTokenCount(point.inputTokens)}</div>`,
            `<div><span style="color:${palette.output}">●</span> Output: ${formatTokenCount(point.outputTokens)}</div>`,
            point.reasoningTokens > 0
              ? `<div>Reasoning: ${formatTokenCount(point.reasoningTokens)}</div>`
              : "",
            `<div style="margin-top:3px;border-top:1px solid ${palette.tooltipBorder};padding-top:3px"><span style="color:${palette.hitRate}">─</span> Cache Hit Rate: <b>${hitText}</b></div>`,
          ]
            .filter(Boolean)
            .join("");
        },
      },
      legend: {
        top: 0,
        right: 0,
        itemWidth: 10,
        itemHeight: 8,
        textStyle: { color: palette.textMuted, fontSize: 11 },
      },
      grid: { top: 34, left: 48, right: 44, bottom: 24 },
      xAxis: {
        type: "category",
        data: labels,
        axisLine: { lineStyle: { color: palette.axisLine } },
        axisTick: { show: false },
        axisLabel: { color: palette.textMuted, fontSize: 10.5 },
      },
      yAxis: [
        {
          type: "value",
          splitLine: { lineStyle: { color: palette.splitLine } },
          axisLabel: {
            color: palette.textMuted,
            fontSize: 10.5,
            formatter: (v: number) => (v === 0 ? "0" : formatTokenCount(v)),
          },
        },
        {
          type: "value",
          min: 0,
          max: 100,
          splitLine: { show: false },
          axisLabel: {
            color: palette.textMuted,
            fontSize: 10.5,
            formatter: "{value}%",
          },
        },
      ],
      series: [
        {
          name: "Cache Read",
          type: "bar",
          stack: "tokens",
          barMaxWidth: 26,
          itemStyle: { color: palette.cacheRead },
          data: metrics.daily.map((d) => d.cacheReadTokens),
        },
        {
          name: "Uncached In",
          type: "bar",
          stack: "tokens",
          barMaxWidth: 26,
          itemStyle: { color: palette.input },
          data: metrics.daily.map((d) => d.inputTokens),
        },
        {
          name: "Output",
          type: "bar",
          stack: "tokens",
          barMaxWidth: 26,
          itemStyle: { color: palette.output, borderRadius: [3, 3, 0, 0] },
          data: metrics.daily.map((d) => d.outputTokens),
        },
        {
          name: "Cache Hit %",
          type: "line",
          yAxisIndex: 1,
          smooth: 0.25,
          symbol: "circle",
          symbolSize: 5,
          connectNulls: false,
          lineStyle: { color: palette.hitRate, width: 2 },
          itemStyle: { color: palette.hitRate },
          data: metrics.daily.map((d) => d.cacheHitRate),
        },
      ],
    };
  }, [metrics.daily, palette]);

  // Chart 2: Daily Task & Pipeline Execution Outcomes
  const automationOption = useMemo<EChartOption>(() => {
    const labels = metrics.daily.map((d) => formatShortDate(d.date));
    return {
      animationDuration: 300,
      tooltip: {
        trigger: "axis",
        backgroundColor: palette.tooltipBg,
        borderColor: palette.tooltipBorder,
        borderWidth: 1,
        textStyle: { color: palette.textPrimary, fontSize: 11, fontFamily: "monospace" },
      },
      legend: {
        top: 0,
        right: 0,
        itemWidth: 10,
        itemHeight: 8,
        textStyle: { color: palette.textMuted, fontSize: 11 },
      },
      grid: { top: 34, left: 36, right: 12, bottom: 24 },
      xAxis: {
        type: "category",
        data: labels,
        axisLine: { lineStyle: { color: palette.axisLine } },
        axisTick: { show: false },
        axisLabel: { color: palette.textMuted, fontSize: 10.5 },
      },
      yAxis: {
        type: "value",
        minInterval: 1,
        splitLine: { lineStyle: { color: palette.splitLine } },
        axisLabel: { color: palette.textMuted, fontSize: 10.5 },
      },
      series: [
        {
          name: "Task 成功",
          type: "bar",
          stack: "runs",
          barMaxWidth: 22,
          itemStyle: { color: palette.taskOk },
          data: metrics.daily.map((d) => d.taskSuccess),
        },
        {
          name: "Pipeline 完成",
          type: "bar",
          stack: "runs",
          barMaxWidth: 22,
          itemStyle: { color: palette.pipelineOk },
          data: metrics.daily.map((d) => d.pipelineCompleted),
        },
        {
          name: "失败",
          type: "bar",
          stack: "runs",
          barMaxWidth: 22,
          itemStyle: { color: palette.failed, borderRadius: [3, 3, 0, 0] },
          data: metrics.daily.map((d) => d.taskFailed + d.pipelineFailed),
        },
      ],
    };
  }, [metrics.daily, palette]);

  // Chart 3: Horizontal Breakdown (By Model or By Source)
  const breakdownItems = useMemo(() => {
    if (breakdownTab === "model") {
      return metrics.byModel.slice(0, 6).map((item) => ({
        label: item.model,
        tokens: item.totalTokens,
        secondary: `${item.turnCount} turns${item.cacheHitRate !== null ? ` · ${item.cacheHitRate}% hit` : ""}`,
      }));
    }
    return metrics.bySource.slice(0, 6).map((item) => ({
      label: SOURCE_LABEL[item.source] ?? item.source,
      tokens: item.totalTokens,
      secondary: `${item.sessionCount} sessions · ${item.turnCount} turns`,
    }));
  }, [breakdownTab, metrics.byModel, metrics.bySource]);

  const breakdownOption = useMemo<EChartOption>(() => {
    const ordered = [...breakdownItems].reverse();
    const total = ordered.reduce((sum, item) => sum + item.tokens, 0);
    return {
      animationDuration: 260,
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        backgroundColor: palette.tooltipBg,
        borderColor: palette.tooltipBorder,
        borderWidth: 1,
        textStyle: { color: palette.textPrimary, fontSize: 11, fontFamily: "monospace" },
        formatter: (params: unknown) => {
          const list = Array.isArray(params) ? params : [];
          const idx = (list[0] as { dataIndex?: number } | undefined)?.dataIndex ?? 0;
          const item = ordered[idx];
          if (!item) return "";
          const pct = total > 0 ? `${Math.round((item.tokens / total) * 1000) / 10}%` : "0%";
          return [
            `<div style="font-weight:600;margin-bottom:2px">${escapeHtml(item.label)}</div>`,
            `<div>Tokens: <b>${formatTokenCount(item.tokens)}</b> (${pct})</div>`,
            `<div style="opacity:0.8">${escapeHtml(item.secondary)}</div>`,
          ].join("");
        },
      },
      grid: { top: 8, left: 120, right: 56, bottom: 18 },
      xAxis: {
        type: "value",
        splitLine: { lineStyle: { color: palette.splitLine } },
        axisLabel: {
          color: palette.textMuted,
          fontSize: 10,
          formatter: (v: number) => (v === 0 ? "0" : formatTokenCount(v)),
        },
      },
      yAxis: {
        type: "category",
        data: ordered.map((item) =>
          item.label.length > 18 ? `${item.label.slice(0, 16)}…` : item.label,
        ),
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: palette.textPrimary, fontSize: 11, fontFamily: "monospace" },
      },
      series: [
        {
          type: "bar",
          barMaxWidth: 18,
          itemStyle: {
            color: breakdownTab === "model" ? palette.input : palette.cacheRead,
            borderRadius: [0, 4, 4, 0],
          },
          label: {
            show: true,
            position: "right",
            color: palette.textMuted,
            fontSize: 10.5,
            fontFamily: "monospace",
            formatter: (params: unknown) => {
              const val = Number((params as { value?: number }).value ?? 0);
              return formatTokenCount(val);
            },
          },
          data: ordered.map((item) => item.tokens),
        },
      ],
    };
  }, [breakdownItems, breakdownTab, palette]);

  return (
    <div className="space-y-4">
      {/* Chart 1: Token Usage & Cache Hit Rate */}
      <section className="rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] overflow-hidden">
        <div className="px-4 py-2.5 border-b border-[var(--border-default)] bg-[var(--bg-table-header)] flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <BarChart3 className="w-3.5 h-3.5 text-[var(--text-muted)]" />
            <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-[var(--text-primary)]">
              Token 消耗 & 缓存命中趋势 ({metrics.range})
            </span>
          </div>
          <div className="flex items-center gap-3 font-mono text-[11px] text-[var(--text-muted)]">
            <span>
              总计{" "}
              <strong className="text-[var(--text-primary)]">
                {formatTokenCount(metrics.summary.totalTokens)}
              </strong>
            </span>
            {metrics.summary.cacheHitRate !== null && (
              <span>
                平均命中{" "}
                <strong className="text-emerald-600 dark:text-emerald-400">
                  {metrics.summary.cacheHitRate}%
                </strong>
              </span>
            )}
          </div>
        </div>
        <div className="p-4">
          {hasTokenActivity ? (
            <EChart option={tokenTrendOption} height={240} />
          ) : (
            <div className="h-[220px] flex flex-col items-center justify-center gap-1.5 text-xs font-mono text-[var(--text-muted)]">
              <BarChart3 className="w-5 h-5 opacity-40" />
              <span>近 {metrics.days} 天暂无 Token 消耗记录</span>
            </div>
          )}
        </div>
      </section>

      {/* Row of 2 Charts: Automation Outcomes + Model/Source Breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Chart 2: Automation Trend */}
        <section className="rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] overflow-hidden">
          <div className="px-4 py-2.5 border-b border-[var(--border-default)] bg-[var(--bg-table-header)] flex items-center justify-between gap-2">
            <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-[var(--text-primary)]">
              自动化执行趋势 (Tasks & Pipelines)
            </span>
            <span className="font-mono text-[10.5px] text-[var(--text-muted)]">
              {metrics.summary.taskTotal + metrics.summary.pipelineTotal} 次
            </span>
          </div>
          <div className="p-4">
            {hasAutomationActivity ? (
              <EChart option={automationOption} height={220} />
            ) : (
              <div className="h-[220px] flex flex-col items-center justify-center gap-1.5 text-xs font-mono text-[var(--text-muted)]">
                <span>近 {metrics.days} 天暂无 Task / Pipeline 执行记录</span>
              </div>
            )}
          </div>
        </section>

        {/* Chart 3: Model / Source Breakdown */}
        <section className="rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] overflow-hidden">
          <div className="px-4 py-2 border-b border-[var(--border-default)] bg-[var(--bg-table-header)] flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5 text-[var(--text-muted)]" />
              <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-[var(--text-primary)]">
                用量分布
              </span>
            </div>
            <div className="inline-flex items-center p-0.5 rounded-[var(--radius-xs)] bg-[var(--bg-canvas)] border border-[var(--border-default)] font-mono text-[10px]">
              <button
                type="button"
                onClick={() => setBreakdownTab("model")}
                className={`px-2 py-0.5 rounded-[var(--radius-xs)] transition-colors cursor-pointer ${
                  breakdownTab === "model"
                    ? "bg-[var(--primary)] text-[var(--text-inverted)] font-medium"
                    : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                }`}
              >
                按模型
              </button>
              <button
                type="button"
                onClick={() => setBreakdownTab("source")}
                className={`px-2 py-0.5 rounded-[var(--radius-xs)] transition-colors cursor-pointer ${
                  breakdownTab === "source"
                    ? "bg-[var(--primary)] text-[var(--text-inverted)] font-medium"
                    : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                }`}
              >
                按来源
              </button>
            </div>
          </div>
          <div className="p-4">
            {breakdownItems.length > 0 && breakdownItems.some((item) => item.tokens > 0) ? (
              <EChart option={breakdownOption} height={220} />
            ) : breakdownTab === "source" && breakdownItems.length > 0 ? (
              <div className="h-[220px] flex flex-col justify-center space-y-2.5 font-mono text-xs">
                {breakdownItems.map((item) => (
                  <div
                    key={item.label}
                    className="flex items-center justify-between px-3 py-2 rounded-[var(--radius-sm)] bg-[var(--bg-canvas)] border border-[var(--border-default)]"
                  >
                    <span className="font-medium text-[var(--text-primary)]">{item.label}</span>
                    <span className="text-[11px] text-[var(--text-muted)]">{item.secondary}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="h-[220px] flex flex-col items-center justify-center gap-1.5 text-xs font-mono text-[var(--text-muted)]">
                <span>近 {metrics.days} 天暂无分布数据</span>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
