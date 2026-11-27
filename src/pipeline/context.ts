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

/**
 * The template variables of a node: `data`, `metadata` and `pipeline`. Agent prompts and code
 * nodes' `ctx.render` see the same ones.
 */
export function nodePromptScopes(
  run: PipelineRunRecord,
  node: Pick<PipelineNodeConfig, "id" | "name">,
  nodeRun: Pick<PipelineNodeRunRecord, "attempt">,
  data: Readonly<Record<string, unknown>>,
  metadata: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    data,
    metadata,
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
      data,
      metadata,
    },
  };
}

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
    data: run.data,
    metadata: run.metadata,
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
  readonly nextNode?: PipelineNodeConfig | undefined;
}): Promise<string> {
  const { store, project, run, nodes, nodeRun, node, nextNode } = params;
  // Flow rules come from the revision the run is bound to; the prompt & input contract from live definition.
  const boundIndex = nodes.findIndex((n) => n.id === node.id);
  const bound: PipelineNodeSnapshot =
    boundIndex >= 0
      ? nodes[boundIndex]!
      : {
          id: node.id,
          name: node.name,
          executor: node.executor,
          terminal: node.terminal,
          gate: node.gate,
          allowPrev: node.allowPrev,
          prevTargets: node.prevTargets,
          maxLoops: node.maxLoops,
        };
  const upstream = nodeRun.triggeredByRecordId
    ? await store.getActionRecord(nodeRun.triggeredByRecordId)
    : null;
  const nodeData = nodeRun.inputContext;
  const nodeMetadata = {
    ...run.metadata,
    ...(upstream?.context.metadata ?? {}),
  };

  const body = renderPromptTemplate(node.promptTemplate ?? "", {
    project: buildProjectPromptScope(project),
    vars: project.vars ?? {},
    now: buildNowPromptScope(),
    ...nodePromptScopes(run, node, nodeRun, nodeData, nodeMetadata),
  }).rendered;

  return [
    body.trim(),
    overviewSection(run, nodeRun, bound, nodeMetadata),
    ...(upstream ? [upstreamSection(upstream)] : []),
    ...summariesSection(run, nodes),
    completionSection(bound, nextNode),
  ].join("\n\n---\n\n");
}

function overviewSection(
  run: PipelineRunRecord,
  nodeRun: PipelineNodeRunRecord,
  node: PipelineNodeSnapshot,
  nodeMetadata: Record<string, unknown>,
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
  if (Object.keys(nodeRun.inputContext).length > 0) {
    lines.push(
      `- **Node Input Data**:\n\`\`\`json\n${JSON.stringify(nodeRun.inputContext, null, 2)}\n\`\`\``,
    );
  }
  if (Object.keys(nodeMetadata).length > 0) {
    lines.push(
      `- **Metadata**:\n\`\`\`json\n${JSON.stringify(nodeMetadata, null, 2)}\n\`\`\``,
    );
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
    lines.push(`\n### Structured Data\n\`\`\`json\n${JSON.stringify(ctx.data, null, 2)}\n\`\`\``);
  }
  if (ctx.metadata && Object.keys(ctx.metadata).length > 0) {
    lines.push(`\n### Metadata\n\`\`\`json\n${JSON.stringify(ctx.metadata, null, 2)}\n\`\`\``);
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

function completionSection(
  node: PipelineNodeSnapshot,
  nextNode: PipelineNodeConfig | undefined,
): string {
  const nextHint = nextNode?.inputSchema
    ? `- \`pipeline_next({ summary, content, data, artifacts?, metadata? })\` to proceed (populate \`data\` per the tool's required schema for \`${nextNode.id}\`).`
    : "- `pipeline_next({ summary, content, artifacts?, metadata? })` to proceed.";
  const prevHint = node.allowPrev
    ? `- \`pipeline_prev({ reason, feedback${node.prevTargets.length > 1 ? `, targetNodeId: one of [${node.prevTargets.join(", ")}]` : ""}, data?, metadata? })\` to reject back upstream.`
    : "- `pipeline_prev` is disabled on this node.";
  return [
    "## Required Completion Action",
    "When you finish this node, you MUST invoke exactly one flow action with explicit context:",
    nextHint,
    prevHint,
    "- `pipeline_request_confirmation({ summary, question, options?, content?, metadata? })` to pause and ask a human.",
    "- `pipeline_fail({ reason, summary?, metadata? })` if blocked by an unrecoverable error.",
  ].join("\n");
}

export const MISSING_ACTION_REMINDER = [
  "[System Reminder] Your previous turn finished without calling a pipeline flow action.",
  "Please invoke exactly one of: `pipeline_next`, `pipeline_prev`, `pipeline_request_confirmation`, or `pipeline_fail` with explicit context.",
].join("\n");
