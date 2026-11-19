import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { ProjectConfig } from "../domain/types.ts";
import { Logger } from "../observability/logger.ts";

export interface ProjectSkill {
  id: string;
  name: string;
  description: string;
  dirPath: string;
  skillFilePath: string;
  metadata?: Record<string, unknown>;
}

export class SkillManager {
  private static readonly logger = new Logger();

  static getSkillsDir(project: ProjectConfig): string | undefined {
    if (!project.projectDir) return undefined;
    return path.resolve(project.projectDir, ".skills");
  }

  static parseSkillMd(
    content: string,
    fallbackName: string,
  ): { name: string; description: string; metadata: Record<string, unknown> } {
    let name = fallbackName;
    let description = "";
    const metadata: Record<string, unknown> = {};

    const trimmed = content.trim();
    if (trimmed.startsWith("---")) {
      const endIdx = trimmed.indexOf("\n---", 3);
      if (endIdx !== -1) {
        const frontmatter = trimmed.slice(3, endIdx).trim();
        for (const line of frontmatter.split("\n")) {
          const colonIdx = line.indexOf(":");
          if (colonIdx > 0) {
            const key = line.slice(0, colonIdx).trim();
            let val = line.slice(colonIdx + 1).trim();
            if (
              (val.startsWith('"') && val.endsWith('"')) ||
              (val.startsWith("'") && val.endsWith("'"))
            ) {
              val = val.slice(1, -1);
            }
            metadata[key] = val;
          }
        }
        if (typeof metadata.name === "string" && metadata.name) {
          name = metadata.name;
        }
        if (typeof metadata.description === "string" && metadata.description) {
          description = metadata.description;
        }
      }
    }

    if (!description) {
      const body = trimmed.startsWith("---")
        ? trimmed.slice(trimmed.indexOf("\n---", 3) + 4).trim()
        : trimmed;
      const lines = body
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      for (const line of lines) {
        if (line.startsWith("#")) {
          if (name === fallbackName) {
            name = line.replace(/^#+\s*/, "").trim();
          }
        } else {
          description = line;
          break;
        }
      }
    }

    return { name, description, metadata };
  }

  static async listProjectSkills(project: ProjectConfig): Promise<ProjectSkill[]> {
    const skillsDir = this.getSkillsDir(project);
    if (!skillsDir || !existsSync(skillsDir)) {
      return [];
    }

    try {
      const entries = await readdir(skillsDir, { withFileTypes: true });
      const skills: ProjectSkill[] = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith(".")) continue;

        const skillDir = path.join(skillsDir, entry.name);
        const candidates = ["SKILL.md", "skill.md", "Skill.md"];
        let skillFilePath: string | undefined;

        for (const candidate of candidates) {
          const candidatePath = path.join(skillDir, candidate);
          if (existsSync(candidatePath)) {
            skillFilePath = candidatePath;
            break;
          }
        }

        if (!skillFilePath) continue;

        let content = "";
        try {
          content = await readFile(skillFilePath, "utf-8");
        } catch {
          // ignore read error
        }

        const parsed = this.parseSkillMd(content, entry.name);
        skills.push({
          id: entry.name,
          name: parsed.name,
          description: parsed.description,
          dirPath: skillDir,
          skillFilePath,
          metadata: parsed.metadata,
        });
      }

      return skills;
    } catch (error) {
      this.logger.warn("failed to read project skills directory", {
        projectId: project.id,
        skillsDir,
        error: (error as Error).message,
      });
      return [];
    }
  }
}
