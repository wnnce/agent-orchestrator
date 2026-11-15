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
    repositories: ["org/repo"],
    keywords: ["project-a"],
    routingHints: [],
  },
  runtime: { type: "codex", sandbox: "workspace-write" },
  repositories: [{ id: "main", url: "https://github.com/org/repo.git", baseBranch: "main" }],
  prompts: { default: "You are the agent." },
};

test("project schema rejects routing identity mismatches", () => {
  expect(() =>
    projectConfigSchema.parse({
      ...baseProject,
      routing: { ...baseProject.routing, projectId: "other-project" },
    }),
  ).toThrow("routing.projectId must match id");
});

test("project schema rejects duplicate repository ids", () => {
  expect(() =>
    projectConfigSchema.parse({
      ...baseProject,
      repositories: [
        { id: "repo-1", url: "https://github.com/org/repo-1.git", baseBranch: "main" },
        { id: "repo-1", url: "https://github.com/org/repo-2.git", baseBranch: "main" },
      ],
    }),
  ).toThrow("duplicate repository id: repo-1");
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

  expect(() =>
    projectConfigSchema.parse({
      ...baseProject,
      agent: {
        mcpServers: [{ name: "invalid-agent-mcp" }],
      },
    }),
  ).toThrow("MCP server needs url or command");
});

test("project schema accepts multi-repo configuration with auth", () => {
  const parsed = projectConfigSchema.parse({
    ...baseProject,
    agent: {
      model: "gpt-5-codex",
      reasoningEffort: "high",
      mcpServers: [
        { name: "db", command: "mcp-server-postgres", args: ["--url", "pg://localhost"] },
      ],
    },
    repositories: [
      {
        id: "backend",
        url: "git@github.com:org/backend.git",
        baseBranch: "main",
        isPrimary: true,
        auth: { type: "ssh-key", keyPath: "/keys/id_ed25519" },
      },
      {
        id: "frontend",
        url: "https://github.com/org/frontend.git",
        baseBranch: "main",
        auth: { type: "token", tokenEnv: "GITHUB_TOKEN" },
      },
    ],
    promptsDir: "./prompts/project-a",
  });
  expect(parsed.repositories).toHaveLength(2);
  expect(parsed.repositories[0]?.isPrimary).toBe(true);
  expect(parsed.repositories[0]?.auth?.type).toBe("ssh-key");
  expect(parsed.repositories[1]?.auth?.tokenEnv).toBe("GITHUB_TOKEN");
  expect(parsed.agent?.model).toBe("gpt-5-codex");
});

test("loadProjects successfully loads from projects directory and ignores disabled projects", async () => {
  const projectsDir = path.resolve(import.meta.dir, "../projects");
  const projects = await loadProjects(projectsDir);
  expect(projects.length).toBeGreaterThanOrEqual(1);

  // Enabled projects like shortlink are loaded
  const shortlink = projects.find((item) => item.id === "shortlink")!;
  expect(shortlink).toBeDefined();
  expect(shortlink.id).toBe("shortlink");
  expect(shortlink.displayName).toBe("Shortlink");
  expect(shortlink.repositories).toHaveLength(1);

  // Disabled projects like example are NOT scanned/loaded
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
repositories:
  - id: repo1
    url: https://github.com/test/repo1.git
    baseBranch: main
    isPrimary: true
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
  expect(p.repositories).toHaveLength(2);
  expect(p.repositories[0]?.id).toBe("service");
  expect(p.repositories[0]?.isPrimary).toBe(true);
  expect(p.repositories[1]?.id).toBe("proto");
  expect(p.agent?.model).toBe("gpt-5-codex");
});
