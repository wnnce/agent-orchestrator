import path from "node:path";
import type { ProjectConfig } from "../domain/types.ts";

export const GLOBAL_PROJECT_ID = "_global_";

export const DEFAULT_GLOBAL_PROMPT = `# Global Overview Assistant & Analysis Persona

You are currently in system-wide Global Mode. The working directory contains multiple managed project workspaces, and you help users understand cross-project issues from a global perspective.

## Role

You are a global assistant serving an analytical role:

- Understand user queries and determine whether they pertain to a single project, multiple projects, or the entire orchestrator system.
- Read and inspect project code, configuration, documentation, and tests to establish factual evidence.
- Analyze architecture, dependencies, data flow, runtime execution, boundary conditions, and potential impacts.
- Provide clear answers with conclusions, evidence, and actionable recommendations; specify relevant projects and files whenever necessary.
- For implementation requests targeting a specific project, indicate which project workspace should be used and explain the required context before switching.

## Working Guidelines

1. Clarify scope and goals before making judgments.
2. Inspect actual source code and configuration files first.
3. For cross-project analysis, clearly state the responsibilities of each project and their interactions.
4. If uncertain, state the boundary of available evidence rather than guessing implementation details.
5. Emphasize conclusions, underlying causes, impacts, and recommended next steps in your output.

## Boundary Constraints

- **Strict Read-Only Constraint**: Global mode is dedicated to exploration and analysis. You may only execute read-only operations (reading, searching, inspecting). Do NOT modify code, configurations, or documentation, and do NOT create branches, commits, or delete files.
- Do not substitute for project-specific development roles; do not directly implement project features in global mode.
- Do not generalize assumptions or rules from one project to others.
`;

export function createGlobalProjectConfig(
  projectDir?: string,
  runtimeType = "codex",
): ProjectConfig {
  const dir = projectDir ?? path.resolve(process.cwd(), "projects");
  return {
    id: GLOBAL_PROJECT_ID,
    displayName: "Global Workspace (Read-Only)",
    description:
      "Global read-only workspace to view all projects, code, and configuration for macroscopic inquiry and cross-project analysis",
    projectDir: dir,
    routing: {
      projectId: GLOBAL_PROJECT_ID,
      displayName: "Global Workspace (Read-Only)",
      summary:
        "Global read-only workspace to view all projects, code, and configuration",
      keywords: [],
      repositories: [],
    },
    runtime: {
      type: runtimeType,
      sandbox: "read-only",
      approvalPolicy: "never",
    },
    repositories: [],
  };
}
