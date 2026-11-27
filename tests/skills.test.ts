import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { SkillManager } from "../src/project/skills.ts";
import { projectSkillSources } from "../src/runtime/skills.ts";
import type { ProjectConfig } from "../src/domain/types.ts";
import { ProjectManager } from "../src/project/manager.ts";
import { MemoryStore } from "../src/persistence/store.ts";
import { Logger } from "../src/observability/logger.ts";
import { createGateway } from "./helpers/gateway.ts";

const testBaseDir = path.resolve("/tmp/orchestrator-skills-test-" + Date.now());

function makeProject(id: string, projectDir: string): ProjectConfig {
  return {
    id,
    displayName: id,
    description: `Test project ${id}`,
    projectDir,
    routing: { projectId: id, keywords: [id] },
    repository: { url: `file://${projectDir}/repo`, baseBranch: "main" },
  };
}

describe("Project-level .skills Support", () => {
  beforeEach(async () => {
    await mkdir(testBaseDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testBaseDir, { recursive: true, force: true }).catch(() => {});
  });

  test("SkillManager.parseSkillMd parses frontmatter and fallback formats", () => {
    // 1. Full YAML frontmatter
    const md1 = `---
name: code-auditor
description: Performs rigorous code audit
version: 1.0.0
---
# Instructions
Do audit.`;
    const res1 = SkillManager.parseSkillMd(md1, "fallback-dir");
    expect(res1.name).toBe("code-auditor");
    expect(res1.description).toBe("Performs rigorous code audit");
    expect(res1.metadata.version).toBe("1.0.0");

    // 2. Heading + paragraph without frontmatter
    const md2 = `# Deploy Automation
Deploys containers to production cluster automatically.

## Notes
Be careful.`;
    const res2 = SkillManager.parseSkillMd(md2, "fallback-dir");
    expect(res2.name).toBe("Deploy Automation");
    expect(res2.description).toBe("Deploys containers to production cluster automatically.");

    // 3. Fallback to folder name
    const md3 = ``;
    const res3 = SkillManager.parseSkillMd(md3, "my-tool");
    expect(res3.name).toBe("my-tool");
    expect(res3.description).toBe("");
  });

  test("SkillManager.listProjectSkills discovers skills in .skills directory", async () => {
    const projDir = path.join(testBaseDir, "proj-a");
    const skillsDir = path.join(projDir, ".skills");
    await mkdir(path.join(skillsDir, "skill-one"), { recursive: true });
    await mkdir(path.join(skillsDir, "skill-two"), { recursive: true });
    await mkdir(path.join(skillsDir, "not-a-skill"), { recursive: true }); // no SKILL.md

    await writeFile(
      path.join(skillsDir, "skill-one", "SKILL.md"),
      `---\nname: skill-one\ndescription: First Skill\n---\nBody 1`,
    );
    await writeFile(
      path.join(skillsDir, "skill-two", "skill.md"),
      `# Skill Two\nSecond Skill Description`,
    );

    const project = makeProject("proj-a", projDir);
    const skills = await SkillManager.listProjectSkills(project);

    expect(skills.length).toBe(2);
    const s1 = skills.find((s) => s.id === "skill-one");
    const s2 = skills.find((s) => s.id === "skill-two");

    expect(s1).toBeDefined();
    expect(s1?.name).toBe("skill-one");
    expect(s1?.description).toBe("First Skill");

    expect(s2).toBeDefined();
    expect(s2?.name).toBe("Skill Two");
    expect(s2?.description).toBe("Second Skill Description");
  });

  test("a session loads the global project's skills, then the project's own", async () => {
    const globalDir = path.join(testBaseDir, "global");
    const projectDir = path.join(testBaseDir, "project");
    const otherDir = path.join(testBaseDir, "other");
    await mkdir(path.join(globalDir, ".skills", "shared"), { recursive: true });
    await mkdir(path.join(projectDir, ".skills", "project-only"), { recursive: true });
    await mkdir(otherDir, { recursive: true });

    const globalProject = makeProject("global", globalDir);
    expect(projectSkillSources(makeProject("project", projectDir), globalProject)).toEqual([
      { projectId: "global", dir: path.join(globalDir, ".skills") },
      { projectId: "project", dir: path.join(projectDir, ".skills") },
    ]);
    // A project without a .skills directory only gets the global ones.
    expect(projectSkillSources(makeProject("other", otherDir), globalProject)).toEqual([
      { projectId: "global", dir: path.join(globalDir, ".skills") },
    ]);
    // The global project itself is not listed twice.
    expect(projectSkillSources(globalProject, globalProject)).toHaveLength(1);
  });

  test("Gateway GET /projects/:projectId/skills returns project skills", async () => {
    const projDir = path.join(testBaseDir, "proj-api");
    const skillsDir = path.join(projDir, ".skills");
    await mkdir(path.join(skillsDir, "api-skill"), { recursive: true });
    await writeFile(
      path.join(skillsDir, "api-skill", "SKILL.md"),
      `---\nname: api-skill\ndescription: API Skill description\n---\nHello API`,
    );

    const project = makeProject("proj-api", projDir);
    const store = new MemoryStore();
    const logger = new Logger({ level: "error" });
    const appConfig = {
      dataDir: path.join(testBaseDir, "data"),
      artifactDir: path.join(testBaseDir, "artifacts"),
      port: 0,
      host: "localhost",
      codex: {},
    } as any;

    const projectManager = new ProjectManager([project], store, appConfig, logger);
    const gateway = createGateway(appConfig, store, projectManager, logger);

    const res = await gateway.handle(new Request("http://localhost/api/v1/projects/proj-api/skills"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.projectId).toBe("proj-api");
    expect(body.skills.length).toBe(1);
    expect(body.skills[0].id).toBe("api-skill");
    expect(body.skills[0].name).toBe("api-skill");
    expect(body.skills[0].description).toBe("API Skill description");

    const notFoundRes = await gateway.handle(
      new Request("http://localhost/api/v1/projects/non-existent/skills"),
    );
    expect(notFoundRes.status).toBe(404);
  });
});
