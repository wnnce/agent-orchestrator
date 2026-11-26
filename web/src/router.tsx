import React from "react";
import { createBrowserRouter, generatePath, Navigate, useParams, type RouteObject } from "react-router";
import { SessionConversation } from "./components/session/SessionConversation";
import { NotFoundView } from "./components/views/NotFoundView";
import { PipelineRunView } from "./components/views/PipelineRunView";
import { PipelinesView } from "./components/views/PipelinesView";
import { ProjectInfoView } from "./components/views/ProjectInfoView";
import { ScheduledJobsView } from "./components/views/ScheduledJobsView";
import { TasksView } from "./components/views/TasksView";
import { SessionBoard } from "./components/workspace/SessionBoard";
import { useStudio } from "./context/StudioContext";
import { ProjectLayout, type RouteHandle } from "./layouts/ProjectLayout";
import { ROUTES } from "./routes";

function RootRedirect() {
  const { projectsLoaded, resolveDefaultProjectId } = useStudio();

  if (!projectsLoaded) {
    return <div className="h-screen w-screen bg-[var(--bg-canvas)]" />;
  }

  const targetProject = resolveDefaultProjectId();
  if (!targetProject) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-[var(--bg-canvas)] text-xs text-[var(--text-muted)] font-mono">
        No projects configured.
      </div>
    );
  }

  return <Navigate to={generatePath(ROUTES.sessions, { projectId: targetProject })} replace />;
}

function SessionConversationRoute() {
  const { sessionId } = useParams<{ sessionId: string }>();
  if (!sessionId) return <NotFoundView />;
  return <SessionConversation sessionId={sessionId} />;
}

export const routes: RouteObject[] = [
  {
    path: "/",
    element: <RootRedirect />,
  },
  {
    path: "/:projectId",
    element: <ProjectLayout />,
    children: [
      {
        index: true,
        element: <Navigate to="sessions" replace />,
      },
      {
        path: "overview",
        element: <Navigate to="../project" replace />,
      },
      {
        path: "project",
        element: <ProjectInfoView />,
        handle: { nav: "project", title: "Overview" } satisfies RouteHandle,
      },
      {
        path: "sessions",
        element: <SessionBoard />,
        handle: { nav: "sessions", title: "Sessions" } satisfies RouteHandle,
      },
      {
        path: "sessions/:sessionId",
        element: <SessionConversationRoute />,
        handle: { nav: "sessions", title: "Sessions" } satisfies RouteHandle,
      },
      {
        path: "pipelines",
        element: <PipelinesView />,
        handle: { nav: "pipelines", title: "Pipelines", transitionKey: "pipelines" } satisfies RouteHandle,
      },
      {
        path: "pipelines/:pipelineId",
        element: <PipelinesView />,
        handle: { nav: "pipelines", title: "Pipelines", transitionKey: "pipelines" } satisfies RouteHandle,
      },
      {
        path: "pipelines/:pipelineId/runs/:runId",
        element: <PipelineRunView />,
        handle: { nav: "pipelines", title: "Pipelines" } satisfies RouteHandle,
      },
      {
        path: "tasks",
        element: <TasksView />,
        handle: { nav: "tasks", title: "Tasks", transitionKey: "tasks" } satisfies RouteHandle,
      },
      {
        path: "tasks/:taskId",
        element: <TasksView />,
        handle: { nav: "tasks", title: "Tasks", transitionKey: "tasks" } satisfies RouteHandle,
      },
      {
        path: "tasks/:taskId/:executionId",
        element: <TasksView />,
        handle: { nav: "tasks", title: "Tasks", transitionKey: "tasks" } satisfies RouteHandle,
      },
      {
        path: "jobs",
        element: <ScheduledJobsView />,
        handle: { nav: "jobs", title: "Scheduled Jobs" } satisfies RouteHandle,
      },
    ],
  },
  {
    path: "*",
    element: <NotFoundView />,
  },
];

export function createAppRouter() {
  return createBrowserRouter(routes);
}
