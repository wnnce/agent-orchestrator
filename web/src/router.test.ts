import { describe, expect, test } from "bun:test";
import { matchRoutes } from "react-router";
import type { RouteHandle } from "./layouts/ProjectLayout";
import { routes } from "./router";

describe("web router table", () => {
  test("matches root path", () => {
    const matched = matchRoutes(routes, "/");
    expect(matched).toHaveLength(1);
    expect(matched?.[0]?.route.path).toBe("/");
  });

  test("matches project index, overview redirect, and all studio views with handle metadata", () => {
    const projectIndex = matchRoutes(routes, "/demo");
    expect(projectIndex?.at(-1)?.route.index).toBe(true);
    expect(projectIndex?.at(-1)?.params.projectId).toBe("demo");

    const overview = matchRoutes(routes, "/demo/overview");
    expect(overview?.at(-1)?.route.path).toBe("overview");

    const projectInfo = matchRoutes(routes, "/demo/project");
    expect(projectInfo?.at(-1)?.route.handle as RouteHandle).toEqual({
      nav: "project",
      title: "Overview",
    });

    const board = matchRoutes(routes, "/demo/sessions");
    expect(board?.at(-1)?.route.handle as RouteHandle).toEqual({
      nav: "sessions",
      title: "Sessions",
    });

    const conv = matchRoutes(routes, "/demo/sessions/ses_123");
    expect(conv?.at(-1)?.params).toEqual({ projectId: "demo", sessionId: "ses_123" });
    expect(conv?.at(-1)?.route.handle as RouteHandle).toEqual({
      nav: "sessions",
      title: "Sessions",
    });

    const pipelinesIndex = matchRoutes(routes, "/demo/pipelines");
    expect(pipelinesIndex?.at(-1)?.route.handle as RouteHandle).toEqual({
      nav: "pipelines",
      title: "Pipelines",
      transitionKey: "pipelines",
    });

    const pipelineBoard = matchRoutes(routes, "/demo/pipelines/issue-to-pr");
    expect(pipelineBoard?.at(-1)?.params).toEqual({
      projectId: "demo",
      pipelineId: "issue-to-pr",
    });
    expect(pipelineBoard?.at(-1)?.route.handle as RouteHandle).toEqual({
      nav: "pipelines",
      title: "Pipelines",
      transitionKey: "pipelines",
    });

    const pipelineRun = matchRoutes(routes, "/demo/pipelines/issue-to-pr/runs/prun_123");
    expect(pipelineRun?.at(-1)?.params).toEqual({
      projectId: "demo",
      pipelineId: "issue-to-pr",
      runId: "prun_123",
    });
    expect(pipelineRun?.at(-1)?.route.handle as RouteHandle).toEqual({
      nav: "pipelines",
      title: "Pipelines",
    });

    const taskExec = matchRoutes(routes, "/demo/tasks/daily/exec_1");
    expect(taskExec?.at(-1)?.params).toEqual({
      projectId: "demo",
      taskId: "daily",
      executionId: "exec_1",
    });
    expect(taskExec?.at(-1)?.route.handle as RouteHandle).toEqual({
      nav: "tasks",
      title: "Tasks",
      transitionKey: "tasks",
    });

    const jobs = matchRoutes(routes, "/demo/jobs");
    expect(jobs?.at(-1)?.route.handle as RouteHandle).toEqual({
      nav: "jobs",
      title: "Scheduled Jobs",
    });
  });

  test("falls through to top-level wildcard 404 route for unknown views and invalid deep paths", () => {
    for (const path of [
      "/demo/unknown-view",
      "/demo/sessions/ses_1/extra",
      "/demo/pipelines/p1/runs/r1/extra",
      "/demo/tasks/t1/e1/extra",
      "/a/b/c/d",
    ]) {
      const matched = matchRoutes(routes, path);
      expect(matched).toHaveLength(1);
      expect(matched?.[0]?.route.path).toBe("*");
    }
  });
});
