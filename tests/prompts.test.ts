import { expect, test } from "bun:test";
import { PromptManager } from "../src/project/prompts.ts";
import type { ProjectConfig } from "../src/domain/types.ts";
import path from "node:path";

const rootDir = path.resolve(import.meta.dir, "..");

test("PromptManager loads prompts directly from projectDir without promptsDir config", async () => {
  const manager = new PromptManager(rootDir);
  const project: ProjectConfig = {
    id: "example",
    displayName: "Example Project",
    description: "Testing prompts",
    projectDir: "./projects/example",
    routing: { projectId: "example" },
    repositories: [{ id: "main", url: "https://github.com/org/repo.git", baseBranch: "main" }],
  };

  const system = await manager.load(project, "system");
  expect(system).toBeDefined();
  expect(system).toContain("# System Prompt for Example Project");

  const fix = await manager.load(project, "fix");
  expect(fix).toBeDefined();
  expect(fix).toContain("# Bug Fixing & Implementation Workflow");

  const all = await manager.loadAll(project);
  expect(all.system).toBeDefined();
  expect(all.fix).toBeDefined();
  expect(all.analyze).toBeDefined();
  expect(all.rules).toBeDefined();
});

test("PromptManager loads explicit markdown prompt file", async () => {
  const manager = new PromptManager(rootDir);
  const project: ProjectConfig = {
    id: "test-project",
    displayName: "Test Project",
    description: "Testing prompts",
    routing: { projectId: "test-project" },
    repositories: [{ id: "main", url: "https://github.com/org/repo.git", baseBranch: "main" }],
    prompts: {
      system: "./projects/example/system.md",
    },
  };

  const content = await manager.load(project, "system");
  expect(content).toBeDefined();
  expect(content).toContain("# System Prompt for Example Project");
});

test("PromptManager loads prompt by convention from promptsDir", async () => {
  const manager = new PromptManager(rootDir);
  const project: ProjectConfig = {
    id: "test-project",
    displayName: "Test Project",
    description: "Testing prompts",
    routing: { projectId: "test-project" },
    repositories: [{ id: "main", url: "https://github.com/org/repo.git", baseBranch: "main" }],
    promptsDir: "./projects/example",
  };

  const fixPrompt = await manager.load(project, "fix");
  expect(fixPrompt).toBeDefined();
  expect(fixPrompt).toContain("# Bug Fixing & Implementation Workflow");

  const missingPrompt = await manager.load(project, "nonexistent");
  expect(missingPrompt).toBeUndefined();
});

test("PromptManager loads all prompts defined in project", async () => {
  const manager = new PromptManager(rootDir);
  const project: ProjectConfig = {
    id: "test-project",
    displayName: "Test Project",
    description: "Testing prompts",
    routing: { projectId: "test-project" },
    repositories: [{ id: "main", url: "https://github.com/org/repo.git", baseBranch: "main" }],
    promptsDir: "./projects/example",
    prompts: {
      custom: "./projects/example/rules.md",
    },
  };

  const all = await manager.loadAll(project);
  expect(all.custom).toContain("# Project Rules & Coding Standards");
  expect(all.system).toContain("# System Prompt for Example Project");
  expect(all.fix).toContain("# Bug Fixing & Implementation Workflow");
  expect(all.analyze).toContain("# Codebase Analysis & Exploration");
  expect(all.rules).toContain("# Project Rules & Coding Standards");
});
