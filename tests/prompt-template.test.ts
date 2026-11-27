import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ArtifactStore } from "../src/artifacts/store.ts";
import { loadProjects } from "../src/config/config.ts";
import type { ProjectConfig } from "../src/domain/types.ts";
import { Logger } from "../src/observability/logger.ts";
import { MemoryStore } from "../src/persistence/store.ts";
import { ProjectRuntime } from "../src/project/runtime.ts";
import {
  buildNowPromptScope,
  buildProjectPromptScope,
  extractPromptVarRefs,
  extractRepoSlug,
  findMissingProjectVars,
  renderPromptTemplate,
} from "../src/prompt/template.ts";
import { FakeRuntime } from "../src/runtime/runtime.ts";
import { TaskLoader } from "../src/task/loader.ts";
import { WorkspaceManager } from "../src/workspace/workspace.ts";

describe("Prompt template variable engine", () => {
  test("renders whitelisted namespaces, deep paths, and serializes objects cleanly", () => {
    const result = renderPromptTemplate(
      [
        "Project: {{project.id}} ({{project.repo.slug}} @ {{project.repo.baseBranch}})",
        "Author: {{vars.githubAuthor}}, Limit: {{vars.maxItems}}, DryRun: {{vars.dryRun}}",
        "Task: {{task.id}} / {{task.key}} / {{task.name}}",
        "Nested cursor: {{state.cursor.page}}, Meta: {{state.meta}}",
        "Full state:\n{{state}}",
      ].join("\n"),
      {
        project: {
          id: "example-service",
          repo: { slug: "example/example-service", baseBranch: "main" },
        },
        vars: { githubAuthor: "alice", maxItems: 20, dryRun: false },
        task: {
          id: "issue-triage",
          key: "example-service:issue-triage",
          name: "Issue Triage",
        },
        state: { cursor: { page: 3 }, meta: { ok: true } },
      },
    );

    expect(result.missingVars).toEqual([]);
    expect(result.rendered).toContain("Project: example-service (example/example-service @ main)");
    expect(result.rendered).toContain("Author: alice, Limit: 20, DryRun: false");
    expect(result.rendered).toContain("Task: issue-triage / example-service:issue-triage / Issue Triage");
    expect(result.rendered).toContain('Nested cursor: 3, Meta: {"ok":true}');
    expect(result.rendered).toContain('"page": 3');
  });

  test("handles fallback defaults, empty defaults, and reports missing variables", () => {
    const result = renderPromptTemplate(
      [
        "Branch: {{vars.branch | main}}",
        "Label: {{vars.label | issue:ready}}",
        "Prefix: [{{vars.prefix | }}]",
        "PipeInDefault: {{vars.sep | a | b}}",
        "MissingA: {{vars.missingA}}",
        "MissingRepeat: {{vars.missingA}}",
        "EmptyWithDefault: {{vars.emptyStr | fallback}}",
      ].join("\n"),
      {
        vars: { label: "custom:ready", emptyStr: "" },
      },
    );

    expect(result.rendered).toBe(
      [
        "Branch: main",
        "Label: custom:ready",
        "Prefix: []",
        "PipeInDefault: a | b",
        "MissingA: ",
        "MissingRepeat: ",
        "EmptyWithDefault: fallback",
      ].join("\n"),
    );
    expect(result.missingVars).toEqual(["vars.missingA"]);
  });

  test("preserves unknown placeholders, code examples, removed legacy aliases, and blocks prototype pollution", () => {
    const template = [
      "Legacy: {{projectId}} {{taskId}} {{taskKey}} {{taskName}}",
      "Env blocked: {{env.GITHUB_TOKEN}}",
      "Proto blocked: {{vars.__proto__}} {{vars.constructor}} {{vars.toString}}",
      "Code snippet: {{ item.name }} and {{ .Values.port }}",
      "Triple brace: {{{project.id}}}",
      "Unclosed before valid: {{unclosed {{project.id}}",
      "Trailing unclosed: {{still_open",
    ].join("\n");

    const result = renderPromptTemplate(template, {
      project: { id: "demo" },
      vars: { safe: "ok" },
    });

    expect(result.rendered).toContain("Legacy: {{projectId}} {{taskId}} {{taskKey}} {{taskName}}");
    expect(result.rendered).toContain("Env blocked: {{env.GITHUB_TOKEN}}");
    expect(result.rendered).toContain("Proto blocked:   ");
    expect(result.rendered).toContain("Code snippet: {{ item.name }} and {{ .Values.port }}");
    expect(result.rendered).toContain("Triple brace: {demo}");
    expect(result.rendered).toContain("Unclosed before valid: {{unclosed demo");
    expect(result.rendered).toContain("Trailing unclosed: {{still_open");
    expect(result.missingVars).toEqual(["vars.__proto__", "vars.constructor", "vars.toString"]);
  });

  test("extracts repo slug safely from SSH, HTTPS, credentialed URLs, and multi-segment GitLab paths", () => {
    expect(extractRepoSlug("git@github.com:example/example-service.git")).toBe(
      "example/example-service",
    );
    expect(extractRepoSlug("https://github.com/example/example-service.git")).toBe(
      "example/example-service",
    );
    expect(extractRepoSlug("https://oauth2:ghp_supersecret@github.com/org/repo")).toBe("org/repo");
    expect(extractRepoSlug("ssh://git@gitlab.internal:2222/group/subgroup/repo.git")).toBe(
      "group/subgroup/repo",
    );
    expect(extractRepoSlug("")).toBeUndefined();
    expect(extractRepoSlug("/local/path/repo")).toBeUndefined();
  });

  test("builds sanitized project scope and timezone-formatted now scope", () => {
    const project: ProjectConfig = {
      id: "demo",
      displayName: "Demo Service",
      description: "Demo description",
      routing: { projectId: "demo" },
      repository: {
        url: "https://token:secret123@github.com/acme/demo-repo.git",
        baseBranch: "develop",
        committer: { name: "Demo Bot", email: "bot@acme.test" },
        auth: { type: "token", token: "secret123" },
      },
      env: { GITHUB_TOKEN: "ghp_secret" },
      credentials: { apiKey: "secret-key" },
    };

    const scope = buildProjectPromptScope(project);
    expect(scope).toEqual({
      id: "demo",
      displayName: "Demo Service",
      description: "Demo description",
      repo: {
        baseBranch: "develop",
        slug: "acme/demo-repo",
        committerName: "Demo Bot",
        committerEmail: "bot@acme.test",
      },
    });
    expect(JSON.stringify(scope)).not.toContain("secret123");
    expect(JSON.stringify(scope)).not.toContain("ghp_secret");

    const fixedDate = new Date("2026-11-24T16:30:05.000Z");
    const shanghai = buildNowPromptScope("Asia/Shanghai", fixedDate);
    expect(shanghai.iso).toBe("2026-11-24T16:30:05.000Z");
    expect(shanghai.date).toBe("2026-11-25");
    expect(shanghai.local).toBe("2026-11-25 00:30:05");

    const invalidTz = buildNowPromptScope("Invalid/Zone_XYZ", fixedDate);
    expect(invalidTz.date).toBe("2026-11-24");
    expect(invalidTz.local).toBe("2026-11-24 16:30:05");
  });

  test("statically extracts variable refs and detects missing project vars", () => {
    const tpl = `
      Repo: {{project.repo.slug}}
      Author: {{vars.githubAuthor}}
      Label: {{vars.label | issue:ready}}
      Missing: {{vars.team}}
    `;

    expect(extractPromptVarRefs(tpl, ["vars"]).map((r) => r.path)).toEqual([
      "vars.githubAuthor",
      "vars.label",
      "vars.team",
    ]);
    expect(findMissingProjectVars(tpl, { githubAuthor: "alice" })).toEqual(["vars.team"]);
  });

  test("end-to-end: loadProjects interpolates vars from .env, strips unresolved {env:...}, and injects into Markdown & TS tasks", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ao-prompt-vars-"));
    const projDir = path.join(root, "example-service");
    const tasksDir = path.join(projDir, "tasks");
    await mkdir(tasksDir, { recursive: true });

    try {
      await writeFile(
        path.join(projDir, ".env"),
        ["GITHUB_TOKEN=ghp_top_secret_never_leak", "GITHUB_AUTHOR=alice"].join("\n"),
      );
      await writeFile(
        path.join(projDir, "project.yaml"),
        `
project:
  id: example-service
  displayName: Example Service
  description: Portable project pack
vars:
  githubAuthor: "{env:GITHUB_AUTHOR}"
  unresolvedVar: "{env:NOT_SET_IN_ENV}"
  maxBatch: 15
repository:
  url: ""
  baseBranch: main
`,
      );
      await writeFile(
        path.join(tasksDir, "scan.md"),
        `---
id: scan
name: Scan Issues
cron: "0 0 * * *"
timezone: "Asia/Shanghai"
enabled: false
---
Repo={{project.id}} Branch={{project.repo.baseBranch}} Author={{vars.githubAuthor}} Batch={{vars.maxBatch}} Missing={{vars.unresolvedVar | fallback}} Date={{now.date}} State={{state.cursor}}
`,
      );
      await writeFile(
        path.join(tasksDir, "feeder.ts"),
        `
import { defineTask } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/task/sdk.ts"))};
export default defineTask({
  id: "feeder",
  name: "Feeder Task",
  cron: "0 0 * * *",
  enabled: false,
  run(ctx) {
    const rendered = ctx.render(
      "TS {{project.id}} author={{vars.githubAuthor}} extra={{custom.tag}} secret={{env.GITHUB_TOKEN}}",
      { custom: { tag: "v1" } },
    );
    ctx.state.set({
      rendered,
      authorVar: ctx.project.vars.githubAuthor,
      maxBatchVar: ctx.project.vars.maxBatch,
    });
  },
});
`,
      );

      const loadedProjects = await loadProjects(root);
      expect(loadedProjects).toHaveLength(1);
      const project = loadedProjects[0]!;
      expect(project.vars).toEqual({
        githubAuthor: "alice",
        maxBatch: 15,
      });

      const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];
      const logger = new Logger({
        level: "warn",
        sink: (line) => {
          const parsed = JSON.parse(line) as { message: string; [k: string]: unknown };
          warnings.push({ message: parsed.message, meta: parsed });
        },
      });

      // Verify loader logs warning for missing project vars
      await writeFile(
        path.join(tasksDir, "missing-var-warn.md"),
        `---
id: missing-var-warn
name: Missing Var Warn
cron: "0 0 * * *"
enabled: false
---
Undefined={{vars.notConfigured}}
`,
      );

      const loader = new TaskLoader(logger);
      const tasks = await loader.loadAllTasks(loadedProjects);
      expect(tasks.length).toBe(3);
      expect(
        warnings.some(
          (w) =>
            w.message.includes("undefined project vars") &&
            Array.isArray(w.meta?.missingVars) &&
            w.meta.missingVars.includes("vars.notConfigured"),
        ),
      ).toBe(true);

      // Verify runtime Markdown + TS rendering
      const store = new MemoryStore();
      const workspaces = new WorkspaceManager(
        path.join(root, "workspaces"),
        path.join(root, "bases"),
      );
      const artifacts = new ArtifactStore(path.join(root, "artifacts"), store);
      const runtime = new ProjectRuntime(
        project,
        store,
        new FakeRuntime(),
        workspaces,
        artifacts,
        undefined,
        new Logger({ sink: () => {} }),
      );

      await runtime.start();
      try {
        const scanTask = (await runtime.listTasks()).find((t) => t.taskId === "scan")!;
        const renderedMd = runtime.renderTaskPrompt(scanTask.promptTemplate, {
          projectId: project.id,
          taskId: scanTask.taskId,
          taskKey: scanTask.taskKey,
          taskName: scanTask.name,
          cron: scanTask.cron,
          timezone: scanTask.timezone,
          state: { cursor: "c-99" },
        });
        expect(renderedMd).toContain(
          "Repo=example-service Branch=main Author=alice Batch=15 Missing=fallback",
        );
        expect(renderedMd).toContain("State=c-99");
        expect(renderedMd).not.toContain("ghp_top_secret_never_leak");

        await runtime.runTask("feeder");
        await runtime.taskEngine.drain();
        const feederState = await runtime.taskEngine.getState("example-service:feeder");
        expect(feederState.authorVar).toBe("alice");
        expect(feederState.maxBatchVar).toBe(15);
        expect(feederState.rendered).toBe(
          "TS example-service author=alice extra=v1 secret={{env.GITHUB_TOKEN}}",
        );
      } finally {
        await runtime.stop();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
