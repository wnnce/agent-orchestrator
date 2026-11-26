import type { ProjectConfig } from "../domain/types.ts";
import type { PipelineStore } from "../persistence/types.ts";
import {
  buildNowPromptScope,
  buildProjectPromptScope,
  renderPromptTemplate,
} from "../prompt/template.ts";
import type {
  PipelineActionContextPayload,
  PipelineActionName,
  PipelineActionRecord,
  PipelineGlobalContextView,
  PipelineHistoryEntrySummary,
  PipelineNodeConfig,
  PipelineNodeRunRecord,
  PipelineNodeSnapshot,
  PipelineRunRecord,
} from "./types.ts";

/** What agents and TS handlers can read about their run. Reads only; never changes state. */

export interface PipelineHistoryQuery {
  readonly recordId?: string | undefined;
  readonly sequence?: number | undefined;
  readonly nodeId?: string | undefined;
  readonly attempt?: number | undefined;
}

export async function buildGlobalContext(
  store: PipelineStore,
  run: PipelineRunRecord,
  nodes: readonly PipelineNodeSnapshot[],
  nodeRun: PipelineNodeRunRecord,
): Promise<PipelineGlobalContextView> {
  const upstreamContext = nodeRun.triggeredByRecordId
    ? await store.getActionRecord(nodeRun.triggeredByRecordId)
    : null;
  return {
    runId: run.runId,
    projectId: run.projectId,
    pipelineId: run.pipelineId,
    pipelineVersion: run.pipelineVersion,
    title: run.title,
    ...(run.description !== undefined ? { description: run.description } : {}),
    ...(run.externalKey !== undefined ? { externalKey: run.externalKey } : {}),
    ...(run.externalUrl !== undefined ? { externalUrl: run.externalUrl } : {}),
    input: run.input,
    ...(run.branchName !== undefined ? { branchName: run.branchName } : {}),
    ...(run.workspacePath !== undefined ? { workspacePath: run.workspacePath } : {}),
    currentNodeId: nodeRun.nodeId,
    currentAttempt: nodeRun.attempt,
    status: run.status,
    nodes,
    ...(upstreamContext ? { upstreamContext } : {}),
    latestNodeOutputs: run.latestNodeOutputs,
  };
}

export async function listHistory(
  store: PipelineStore,
  runId: string,
  filter?: {
    readonly nodeId?: string | undefined;
    readonly action?: PipelineActionName | undefined;
  },
): Promise<PipelineHistoryEntrySummary[]> {
  const records = await store.listActionRecords(runId, {
    ...(filter?.nodeId ? { nodeId: filter.nodeId } : {}),
    ...(filter?.action ? { action: filter.action } : {}),
    limit: 1000,
  });
  return records.map((r) => ({
    recordId: r.recordId,
    sequence: r.sequence,
    nodeId: r.nodeId,
    attempt: r.attempt,
    action: r.action,
    actorType: r.actorType,
    fromNodeId: r.fromNodeId,
    ...(r.toNodeId !== undefined ? { toNodeId: r.toNodeId } : {}),
    ...(r.context.summary !== undefined ? { summary: r.context.summary } : {}),
    ...(r.context.reason !== undefined ? { reason: r.context.reason } : {}),
    createdAt: r.createdAt,
  }));
}

export async function getHistoryDetail(
  store: PipelineStore,
  runId: string,
  query: PipelineHistoryQuery,
): Promise<PipelineActionRecord | null> {
  if (query.recordId) {
    const record = await store.getActionRecord(query.recordId);
    return record?.runId === runId ? record : null;
  }
  if (query.sequence !== undefined) {
    const [record] = await store.listActionRecords(runId, {
      afterSequence: query.sequence - 1,
      limit: 1,
    });
    return record?.sequence === query.sequence ? record : null;
  }
  if (query.nodeId) {
    const records = await store.listActionRecords(runId, { nodeId: query.nodeId, limit: 1000 });
    return (
      records.filter((r) => query.attempt === undefined || r.attempt === query.attempt).at(-1) ??
      null
    );
  }
  return null;
}

/**
 * What an approved node hands to the next one: the latest output the node itself recorded (a
 * manual-gate `pipeline_next` or a confirmation request), else what it was handed itself, which is
 * how a `human` node passes its upstream work through.
 */
export async function resolveApprovalHandoff(
  store: PipelineStore,
  nodeRun: PipelineNodeRunRecord,
): Promise<PipelineActionContextPayload> {
  const records = await store.listActionRecords(nodeRun.runId, {
    nodeId: nodeRun.nodeId,
    limit: 1000,
  });
  const own = records.filter((r) => r.nodeRunId === nodeRun.nodeRunId).at(-1);
  if (own && (own.context.content || own.context.summary)) return own.context;

  if (nodeRun.triggeredByRecordId) {
    const upstream = await store.getActionRecord(nodeRun.triggeredByRecordId);
    if (upstream) return upstream.context;
  }
  return {};
}

export async function buildAgentNodePrompt(params: {
  readonly store: PipelineStore;
  readonly project: ProjectConfig;
  readonly run: PipelineRunRecord;
  readonly nodes: readonly PipelineNodeSnapshot[];
  readonly nodeRun: PipelineNodeRunRecord;
  readonly node: PipelineNodeConfig;
}): Promise<string> {
  const { store, project, run, nodes, nodeRun, node } = params;
  // Flow rules come from the revision the run is bound to; the prompt from the live definition.
  const bound = nodes.find((n) => n.id === node.id) ?? node;
  const upstream = nodeRun.triggeredByRecordId
    ? await store.getActionRecord(nodeRun.triggeredByRecordId)
    : null;

  const body = renderPromptTemplate(node.promptTemplate ?? "", {
    project: buildProjectPromptScope(project),
    vars: project.vars ?? {},
    now: buildNowPromptScope(),
    pipeline: {
      id: run.pipelineId,
      version: run.pipelineVersion,
      runId: run.runId,
      title: run.title,
      description: run.description ?? "",
      externalKey: run.externalKey ?? "",
      externalUrl: run.externalUrl ?? "",
      branchName: run.branchName ?? "",
      nodeId: node.id,
      nodeName: node.name,
      attempt: nodeRun.attempt,
      input: run.input,
    },
  }).rendered;

  return [
    body.trim(),
    overviewSection(run, nodeRun, bound),
    ...(upstream ? [upstreamSection(upstream)] : []),
    ...summariesSection(run, nodes),
    completionSection(bound),
  ].join("\n\n---\n\n");
}

function overviewSection(
  run: PipelineRunRecord,
  nodeRun: PipelineNodeRunRecord,
  node: PipelineNodeSnapshot,
): string {
  const lines = [
    "## Pipeline Run Context",
    `- **Pipeline**: \`${run.pipelineId}\` (v${run.pipelineVersion})`,
    `- **Run ID**: \`${run.runId}\``,
    `- **Current Node**: \`${node.id}\` (${node.name}, attempt #${nodeRun.attempt}, gate=${node.gate})`,
    `- **Title**: ${run.title}`,
  ];
  if (run.description) lines.push(`- **Description**: ${run.description}`);
  if (run.externalUrl) lines.push(`- **External URL**: ${run.externalUrl}`);
  if (run.branchName) lines.push(`- **Shared Git Branch**: \`${run.branchName}\``);
  if (Object.keys(run.input).length > 0) {
    lines.push(`- **Initial Input**:\n\`\`\`json\n${JSON.stringify(run.input, null, 2)}\n\`\`\``);
  }
  return lines.join("\n");
}

function upstreamSection(record: PipelineActionRecord): string {
  const ctx = record.context;
  const isRejection = record.action === "pipeline_prev" || record.action === "human_reject";
  const lines = [
    `## ${isRejection ? "Upstream Rejection Feedback" : "Upstream Handoff"} (from \`${record.fromNodeId}\` via \`${record.action}\`)`,
  ];
  if (ctx.reason) lines.push(`**Reason**: ${ctx.reason}`);
  if (ctx.summary) lines.push(`**Summary**: ${ctx.summary}`);
  if (ctx.feedback) lines.push(`\n### Feedback\n${ctx.feedback}`);
  if (ctx.content) lines.push(`\n### Deliverable\n${ctx.content}`);
  if (ctx.humanNote && ctx.humanNote !== ctx.feedback) {
    lines.push(`\n### Human Note\n${ctx.humanNote}`);
  }
  if (ctx.artifacts && ctx.artifacts.length > 0) {
    lines.push(`\n**Artifacts**: ${ctx.artifacts.map((a) => `\`${a}\``).join(", ")}`);
  }
  if (ctx.data && Object.keys(ctx.data).length > 0) {
    lines.push(`\n\`\`\`json\n${JSON.stringify(ctx.data, null, 2)}\n\`\`\``);
  }
  return lines.join("\n");
}

function summariesSection(
  run: PipelineRunRecord,
  nodes: readonly PipelineNodeSnapshot[],
): string[] {
  const lines = nodes.flatMap((node) => {
    const out = run.latestNodeOutputs[node.id];
    return out
      ? [`- \`${node.id}\` (attempt #${out.attempt}, record \`${out.recordId}\`): ${out.summary}`]
      : [];
  });
  if (lines.length === 0) return [];
  return [
    [
      "## Previous Node Summaries",
      ...lines,
      "",
      "Use `pipeline_list_history` or `pipeline_get_history_detail` if you need full details from earlier nodes.",
    ].join("\n"),
  ];
}

function completionSection(node: PipelineNodeSnapshot): string {
  const prevHint = node.allowPrev
    ? `- \`pipeline_prev({ reason, feedback${node.prevTargets.length > 1 ? `, targetNodeId: one of [${node.prevTargets.join(", ")}]` : ""} })\` to reject back upstream.`
    : "- `pipeline_prev` is disabled on this node.";
  return [
    "## Required Completion Action",
    "When you finish this node, you MUST invoke exactly one flow action with explicit context:",
    "- `pipeline_next({ summary, content, artifacts?, data? })` to proceed.",
    prevHint,
    "- `pipeline_request_confirmation({ summary, question, options?, content? })` to pause and ask a human.",
    "- `pipeline_fail({ reason, summary? })` if blocked by an unrecoverable error.",
  ].join("\n");
}

export const MISSING_ACTION_REMINDER = [
  "[System Reminder] Your previous turn finished without calling a pipeline flow action.",
  "Please invoke exactly one of: `pipeline_next`, `pipeline_prev`, `pipeline_request_confirmation`, or `pipeline_fail` with explicit context.",
].join("\n");
