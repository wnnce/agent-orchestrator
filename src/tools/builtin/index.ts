import type { ToolDefinition } from "../types.ts";
import { createArtifactTool } from "./artifact.ts";
import { sendNotificationTool } from "./notify.ts";
import { pipelineNodeTools } from "./pipeline-node.ts";
import { dispatchPipelineRunTool, listProjectPipelinesTool } from "./pipelines.ts";
import { cancelJobTool, dispatchAgentTaskTool, scheduleJobTool } from "./sessions.ts";
import { updateTaskStateTool } from "./task-state.ts";

export { pipelineNextInput } from "./pipeline-node.ts";

/** The tools every project offers its agents. */
export const builtinTools: readonly ToolDefinition[] = [
  sendNotificationTool,
  createArtifactTool,
  dispatchAgentTaskTool,
  scheduleJobTool,
  cancelJobTool,
  updateTaskStateTool,
  listProjectPipelinesTool,
  dispatchPipelineRunTool,
  ...pipelineNodeTools,
];
