import { expect, test } from "bun:test";
import { projectConfigSchema } from "../src/domain/schemas.ts";
import { loadProjects } from "../src/config/config.ts";
import path from "node:path";
import YAML from "yaml";

const baseProject = {
  id: "project-a",
  displayName: "Project A",
  description: "A project",
  routing: {
    projectId: "project-a",
    displayName: "Project A",
    summary: "A project",
    keywords: ["project-a"],
    routingHints: [],
  },
  runtime: { type: "codex" },
  repository: { url: "https://github.com/org/repo.git", baseBranch: "main" },
};

test("project schema rejects routing identity mismatches", () => {
  expect(() =>
    projectConfigSchema.parse({
      ...baseProject,
      routing: { ...baseProject.routing, projectId: "other-project" },
    }),
  ).toThrow("routing.projectId must match id");
});

test("project schema rejects invalid MCP server definitions", () => {
  expect(() =>
    projectConfigSchema.parse({
      ...baseProject,
      runtime: {
        ...baseProject.runtime,
        mcpServers: [{ name: "invalid" }],
      },
    }),
  ).toThrow("MCP server needs url or command");
});

test("project schema accepts a repository with auth and committer", () => {
  const parsed = projectConfigSchema.parse({
    ...baseProject,
    repository: {
      url: "git@github.com:org/backend.git",
      baseBranch: "main",
      path: "repos/backend",
      auth: { type: "ssh-key", keyPath: "/keys/id_ed25519" },
      committer: { name: "bot", email: "bot@example.com" },
    },
  });
  expect(parsed.repository?.path).toBe("repos/backend");
  expect(parsed.repository?.auth?.type).toBe("ssh-key");
  expect(parsed.repository?.committer?.name).toBe("bot");
});

test("session lifecycle settings live in the session section", () => {
  const parsed = projectConfigSchema.parse({
    ...baseProject,
    session: { idleTimeoutMs: 1000, archiveTimeoutMs: 2000 },
  });
  expect(parsed.session).toEqual({ idleTimeoutMs: 1000, archiveTimeoutMs: 2000 });
  expect(() =>
    projectConfigSchema.parse({ ...baseProject, session: { idleTimeout: 1000 } }),
  ).toThrow();
});

test("project schema rejects fields from before single-repository projects", () => {
  for (const removed of [
    { repositories: [{ id: "main", url: "", baseBranch: "main" }] },
    { committer: { name: "bot" } },
    { auth: { type: "token", token: "t" } },
    { prompts: { system: "system.md" } },
  ]) {
    expect(() => projectConfigSchema.parse({ ...baseProject, ...removed })).toThrow();
  }
  expect(() =>
    projectConfigSchema.parse({
      ...baseProject,
      repository: { ...baseProject.repository, id: "main", isPrimary: true },
    }),
  ).toThrow();
});

test("loadProjects successfully loads from projects directory and ignores disabled projects", async () => {
  const projectsDir = path.resolve(import.meta.dir, "../projects");
  const projects = await loadProjects(projectsDir);

  // The checked-in example is disabled and must not be scanned or loaded.
  const example = projects.find((item) => item.id === "example");
  expect(example).toBeUndefined();
});

test("loadProjects returns empty array for disabled project.yaml directly", async () => {
  const singleFile = path.resolve(import.meta.dir, "../projects/example/project.yaml");
  const projects = await loadProjects(singleFile);
  expect(projects).toHaveLength(0);
});

test("project schema supports nested project meta and enabled flag", async () => {
  const yamlWithProjectMeta = `
project:
  enabled: true
  id: custom-meta-proj
  displayName: Custom Meta
  description: Testing nested meta
  tags: [test, meta]
repository:
  url: https://github.com/test/repo1.git
  baseBranch: main
`;
  const parsed = projectConfigSchema.parse(
    YAML.parse(yamlWithProjectMeta),
  );
  // Verify hoisting
  expect(parsed.id).toBe("custom-meta-proj");
  expect(parsed.displayName).toBe("Custom Meta");
  expect(parsed.description).toBe("Testing nested meta");
  expect(parsed.tags).toEqual(["test", "meta"]);
});

test("project schema successfully loads projects.example.yaml", async () => {
  const examplePath = path.resolve(import.meta.dir, "../projects.example.yaml");
  const projects = await loadProjects(examplePath);
  expect(projects).toHaveLength(1);
  const p = projects[0]!;
  expect(p.id).toBe("example-project");
  expect(p.repository?.url).toBe("git@github.com:my-org/backend-service.git");
  expect(p.runtime?.model).toBe("gpt-5-codex");
});

test("a project chooses only its runtime, model, reasoning effort and MCP servers", () => {
  const parsed = projectConfigSchema.parse({
    ...baseProject,
    runtime: {
      type: "claude",
      model: "claude-sonnet-5-5",
      reasoningEffort: "high",
      mcpServers: [{ name: "db", command: "mcp-server-postgres" }],
    },
  });
  expect(parsed.runtime?.model).toBe("claude-sonnet-5-5");
  // The runtime type may be left to the service's defaultRuntime.
  expect(projectConfigSchema.parse({ ...baseProject, runtime: { model: "m" } }).runtime).toEqual({
    model: "m",
  });
  for (const removed of [
    { sandbox: "workspace-write" },
    { approvalPolicy: "never" },
    { codexHome: "/tmp/codex" },
    { config: { model_verbosity: "low" } },
    { providers: {} },
    { idleTimeoutMs: 1000 },
    { reasoningEffort: "extreme" },
  ]) {
    expect(() =>
      projectConfigSchema.parse({ ...baseProject, runtime: { type: "codex", ...removed } }),
    ).toThrow();
  }
  expect(() =>
    projectConfigSchema.parse({ ...baseProject, agent: { model: "gpt-5-codex" } }),
  ).toThrow();
});
