import type { StudioView } from "../types";

export interface ParsedStudioRoute {
  matched: boolean;
  isRoot: boolean;
  projectId: string | null;
  view: StudioView;
  sessionId: string | null;
  taskId: string | null;
  executionId: string | null;
}

const VALID_VIEWS: Record<string, StudioView> = {
  sessions: "sessions",
  tasks: "tasks",
  jobs: "jobs",
  project: "project",
  overview: "project",
};

function safeDecode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export function parseStudioLocation(location: string): ParsedStudioRoute {
  const path = location.split("?")[0]?.split("#")[0] ?? "/";
  const notFound: ParsedStudioRoute = {
    matched: false,
    isRoot: false,
    projectId: null,
    view: "sessions",
    sessionId: null,
    taskId: null,
    executionId: null,
  };

  if (path === "" || path === "/") {
    return {
      matched: true,
      isRoot: true,
      projectId: null,
      view: "sessions",
      sessionId: null,
      taskId: null,
      executionId: null,
    };
  }

  // 1. /:projectId/sessions/:sessionId
  const sessionMatch = path.match(/^\/([^/]+)\/sessions\/([^/]+)\/?$/);
  if (sessionMatch) {
    const projectId = safeDecode(sessionMatch[1]!);
    const sessionId = safeDecode(sessionMatch[2]!);
    if (!projectId || !sessionId) return notFound;
    return {
      matched: true,
      isRoot: false,
      projectId,
      view: "sessions",
      sessionId,
      taskId: null,
      executionId: null,
    };
  }

  // 2. /:projectId/tasks/:taskId/:executionId
  const taskExecMatch = path.match(/^\/([^/]+)\/tasks\/([^/]+)\/([^/]+)\/?$/);
  if (taskExecMatch) {
    const projectId = safeDecode(taskExecMatch[1]!);
    const taskId = safeDecode(taskExecMatch[2]!);
    const executionId = safeDecode(taskExecMatch[3]!);
    if (!projectId || !taskId || !executionId) return notFound;
    return {
      matched: true,
      isRoot: false,
      projectId,
      view: "tasks",
      sessionId: null,
      taskId,
      executionId,
    };
  }

  // 3. /:projectId/tasks/:taskId
  const taskMatch = path.match(/^\/([^/]+)\/tasks\/([^/]+)\/?$/);
  if (taskMatch) {
    const projectId = safeDecode(taskMatch[1]!);
    const taskId = safeDecode(taskMatch[2]!);
    if (!projectId || !taskId) return notFound;
    return {
      matched: true,
      isRoot: false,
      projectId,
      view: "tasks",
      sessionId: null,
      taskId,
      executionId: null,
    };
  }

  // 4. /:projectId/:view (strictly known views only)
  const viewMatch = path.match(/^\/([^/]+)\/([^/]+)\/?$/);
  if (viewMatch) {
    const projectId = safeDecode(viewMatch[1]!);
    const view = VALID_VIEWS[viewMatch[2]!];
    if (!projectId || !view) return notFound;
    return {
      matched: true,
      isRoot: false,
      projectId,
      view,
      sessionId: null,
      taskId: null,
      executionId: null,
    };
  }

  // 5. /:projectId
  const projMatch = path.match(/^\/([^/]+)\/?$/);
  if (projMatch) {
    const projectId = safeDecode(projMatch[1]!);
    if (!projectId) return notFound;
    return {
      matched: true,
      isRoot: false,
      projectId,
      view: "sessions",
      sessionId: null,
      taskId: null,
      executionId: null,
    };
  }

  return notFound;
}
