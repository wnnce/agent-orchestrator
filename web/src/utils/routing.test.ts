import { describe, expect, test } from "bun:test";
import { parseStudioLocation } from "./routing";

describe("parseStudioLocation", () => {
  test("parses root path", () => {
    expect(parseStudioLocation("/")).toMatchObject({
      matched: true,
      isRoot: true,
      projectId: null,
    });
  });

  test("parses valid project, view, session, and task routes", () => {
    expect(parseStudioLocation("/demo")).toMatchObject({
      matched: true,
      isRoot: false,
      projectId: "demo",
      view: "sessions",
    });
    expect(parseStudioLocation("/demo/overview")).toMatchObject({
      matched: true,
      projectId: "demo",
      view: "project",
    });
    expect(parseStudioLocation("/demo/sessions/ses_123")).toMatchObject({
      matched: true,
      projectId: "demo",
      view: "sessions",
      sessionId: "ses_123",
    });
    expect(parseStudioLocation("/demo/tasks/daily/exec_1")).toMatchObject({
      matched: true,
      projectId: "demo",
      view: "tasks",
      taskId: "daily",
      executionId: "exec_1",
    });
  });

  test("marks unknown views and deep invalid paths as unmatched (404)", () => {
    expect(parseStudioLocation("/demo/unknown-view").matched).toBe(false);
    expect(parseStudioLocation("/demo/sessions/ses_1/extra").matched).toBe(false);
    expect(parseStudioLocation("/a/b/c/d").matched).toBe(false);
    expect(parseStudioLocation("/%E0%A4%A").matched).toBe(false);
  });
});
