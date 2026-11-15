import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, rm, lstat, readlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { SkillManager } from "../src/project/skills.ts";
import type { ProjectConfig } from "../src/domain/types.ts";
import { ProjectManager } from "../src/project/manager.ts";
import { MemoryStore } from "../src/persistence/store.ts";
import { Logger } from "../src/observability/logger.ts";
import { Gateway } from "../src/gateway/server.ts";

const testBaseDir = path.resolve("/tmp/orchestrator-skills-test-" + Date.now());

function makeProject(id: string, projectDir: string): ProjectConfig {
  return {
    id,
    displayName: id,
    description: `Test project ${id}`,
    projectDir,
    routing: { projectId: id, keywords: [id] },
    repositories: [
      {
        id: "main",
        url: `file://${projectDir}/repo`,
        isPrimary: true,
        baseBranch: "main",
      },
    ],
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

  test("SkillManager.syncSkillsToCodex creates symlinks and cleans up stale ones", async () => {
    const projDir = path.join(testBaseDir, "proj-sync");
    const skillsDir = path.join(projDir, ".skills");
    const codexHome = path.join(testBaseDir, "codex-home");

    await mkdir(path.join(skillsDir, "active-skill"), { recursive: true });
    await writeFile(
      path.join(skillsDir, "active-skill", "SKILL.md"),
      `---\nname: active-skill\ndescription: Active\n---\nDo active things`,
    );

    const project = makeProject("proj-sync", projDir);

    // Initial sync
    await SkillManager.syncSkillsToCodex(codexHome, project);

    const linkPath = path.join(codexHome, "skills", "active-skill");
    expect(existsSync(linkPath)).toBe(true);
    const stat1 = await lstat(linkPath);
    expect(stat1.isSymbolicLink()).toBe(true);
    const target1 = await readlink(linkPath);
    expect(path.resolve(path.dirname(linkPath), target1)).toBe(
      path.resolve(skillsDir, "active-skill"),
    );

    // Now remove active-skill from project and add another-skill
    await rm(path.join(skillsDir, "active-skill"), { recursive: true, force: true });
    await mkdir(path.join(skillsDir, "another-skill"), { recursive: true });
    await writeFile(
      path.join(skillsDir, "another-skill", "SKILL.md"),
      `# Another Skill\nAnother description`,
    );

    // Second sync: should prune active-skill symlink and add another-skill symlink
    await SkillManager.syncSkillsToCodex(codexHome, project);

    expect(existsSync(linkPath)).toBe(false);
    const newLinkPath = path.join(codexHome, "skills", "another-skill");
    expect(existsSync(newLinkPath)).toBe(true);
  });

  test("Project-level skills isolation between projects", async () => {
    const proj1Dir = path.join(testBaseDir, "proj1");
    const proj2Dir = path.join(testBaseDir, "proj2");
    const codexHome1 = path.join(testBaseDir, "codex1");
    const codexHome2 = path.join(testBaseDir, "codex2");

    await mkdir(path.join(proj1Dir, ".skills", "proj1-exclusive"), { recursive: true });
    await writeFile(
      path.join(proj1Dir, ".skills", "proj1-exclusive", "SKILL.md"),
      `# P1 Skill\nExclusively for P1`,
    );

    await mkdir(path.join(proj2Dir, ".skills", "proj2-exclusive"), { recursive: true });
    await writeFile(
      path.join(proj2Dir, ".skills", "proj2-exclusive", "SKILL.md"),
      `# P2 Skill\nExclusively for P2`,
    );

    const proj1 = makeProject("p1", proj1Dir);
    const proj2 = makeProject("p2", proj2Dir);

    await SkillManager.syncSkillsToCodex(codexHome1, proj1);
    await SkillManager.syncSkillsToCodex(codexHome2, proj2);

    const p1Skills = await SkillManager.listProjectSkills(proj1);
    const p2Skills = await SkillManager.listProjectSkills(proj2);

    expect(p1Skills.map((s) => s.id)).toEqual(["proj1-exclusive"]);
    expect(p2Skills.map((s) => s.id)).toEqual(["proj2-exclusive"]);

    expect(existsSync(path.join(codexHome1, "skills", "proj1-exclusive"))).toBe(true);
    expect(existsSync(path.join(codexHome1, "skills", "proj2-exclusive"))).toBe(false);

    expect(existsSync(path.join(codexHome2, "skills", "proj2-exclusive"))).toBe(true);
    expect(existsSync(path.join(codexHome2, "skills", "proj1-exclusive"))).toBe(false);
  });

  test("global skills are inherited and project skills override by ID", async () => {
    const globalDir = path.join(testBaseDir, "global");
    const projectDir = path.join(testBaseDir, "project");
    const codexHome = path.join(testBaseDir, "codex-inherited");
    await mkdir(path.join(globalDir, ".skills", "shared"), { recursive: true });
    await writeFile(
      path.join(globalDir, ".skills", "shared", "SKILL.md"),
      "# Global shared\nGlobal",
    );
    await mkdir(path.join(globalDir, ".skills", "global-only"), { recursive: true });
    await writeFile(
      path.join(globalDir, ".skills", "global-only", "SKILL.md"),
      "# Global only\nGlobal",
    );
    await mkdir(path.join(projectDir, ".skills", "shared"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".skills", "shared", "SKILL.md"),
      "# Project shared\nProject",
    );
    await mkdir(path.join(projectDir, ".skills", "project-only"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".skills", "project-only", "SKILL.md"),
      "# Project only\nProject",
    );

    const globalProject = makeProject("global", globalDir);
    const project = makeProject("project", projectDir);
    await SkillManager.syncSkillsToCodex(codexHome, project, globalProject);

    const readTarget = async (id: string) =>
      path.resolve(
        path.dirname(path.join(codexHome, "skills", id)),
        await readlink(path.join(codexHome, "skills", id)),
      );
    expect(await readTarget("global-only")).toBe(path.join(globalDir, ".skills", "global-only"));
    expect(await readTarget("project-only")).toBe(path.join(projectDir, ".skills", "project-only"));
    expect(await readTarget("shared")).toBe(path.join(projectDir, ".skills", "shared"));
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
    const gateway = new Gateway(appConfig, store, projectManager, logger);

    const res = await gateway.handle(new Request("http://localhost/projects/proj-api/skills"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.projectId).toBe("proj-api");
    expect(body.skills.length).toBe(1);
    expect(body.skills[0].id).toBe("api-skill");
    expect(body.skills[0].name).toBe("api-skill");
    expect(body.skills[0].description).toBe("API Skill description");

    const notFoundRes = await gateway.handle(
      new Request("http://localhost/projects/non-existent/skills"),
    );
    expect(notFoundRes.status).toBe(404);
  });
});
