import { generatePath } from "react-router";
import type { StudioView } from "./types";

export const ROUTES = {
  root: "/",
  project: "/:projectId/project",
  sessions: "/:projectId/sessions",
  session: "/:projectId/sessions/:sessionId",
  tasks: "/:projectId/tasks",
  task: "/:projectId/tasks/:taskId",
  taskExecution: "/:projectId/tasks/:taskId/:executionId",
  jobs: "/:projectId/jobs",
} as const;

type ViewRoutePattern =
  | typeof ROUTES.project
  | typeof ROUTES.sessions
  | typeof ROUTES.tasks
  | typeof ROUTES.jobs;

const VIEW_ROUTES: Record<StudioView, ViewRoutePattern> = {
  project: ROUTES.project,
  sessions: ROUTES.sessions,
  tasks: ROUTES.tasks,
  jobs: ROUTES.jobs,
};

export function viewPath(projectId: string, view: StudioView): string {
  return generatePath(VIEW_ROUTES[view], { projectId });
}
