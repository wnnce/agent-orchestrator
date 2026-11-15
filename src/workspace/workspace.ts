import path from "node:path";
import { mkdir, access, rm, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { ProjectConfig, RepositoryConfig, RepoAuthConfig } from "../domain/types.ts";
import { GLOBAL_PROJECT_ID, DEFAULT_GLOBAL_PROMPT } from "../project/global.ts";

function safe(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(value))
    throw new Error(`unsafe path component: ${value}`);
  return value;
}

export function resolveCommitter(
  project: ProjectConfig,
  repo?: RepositoryConfig,
): { name: string; email: string } {
  const name =
    repo?.committer?.name?.trim() ||
    project.committer?.name?.trim() ||
    process.env.GIT_AUTHOR_NAME?.trim() ||
    "Agent Orchestrator";

  const email =
    repo?.committer?.email?.trim() ||
    project.committer?.email?.trim() ||
    process.env.GIT_AUTHOR_EMAIL?.trim() ||
    "agent-orchestrator@localhost";

  return { name, email };
}

export function resolveGitAuthEnv(
  auth?: RepoAuthConfig,
  resolvedKeyPath?: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  if (!auth) {
    return {
      GIT_SSH_COMMAND: "ssh -o StrictHostKeyChecking=accept-new",
    };
  }

  if (auth.type === "ssh-key") {
    const keyPath =
      resolvedKeyPath ??
      auth.keyPath ??
      (auth.key && existsSync(auth.key) ? auth.key : undefined) ??
      (auth.keyEnv ? process.env[auth.keyEnv] : undefined);
    if (keyPath) {
      env.GIT_SSH_COMMAND = `ssh -i "${keyPath}" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
    } else {
      env.GIT_SSH_COMMAND = "ssh -o StrictHostKeyChecking=accept-new";
    }
  } else if (auth.type === "token") {
    const token = auth.token ?? (auth.tokenEnv ? process.env[auth.tokenEnv] : undefined);
    if (token) {
      env.GIT_CONFIG_COUNT = "1";
      env.GIT_CONFIG_KEY_0 = "http.extraheader";
      env.GIT_CONFIG_VALUE_0 = `Authorization: Bearer ${token}`;
    }
  }
  return env;
}

async function run(
  command: string,
  args: string[],
  cwd?: string,
  extraEnv?: Record<string, string>,
): Promise<string> {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", ...(extraEnv ?? {}) };
  const options =
    cwd === undefined
      ? { stdout: "pipe" as const, stderr: "pipe" as const, env }
      : { cwd, stdout: "pipe" as const, stderr: "pipe" as const, env };
  const proc = Bun.spawn([command, ...args], options);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0)
    throw new Error(`${command} ${args.join(" ")} failed (${code}): ${stderr.trim()}`);
  return stdout.trim();
}

export interface SessionWorkspaceInfo {
  sessionRoot: string;
  repoPaths: Map<string, string>;
  primaryPath: string;
}

export class WorkspaceManager {
  private readonly sessionRoot: string;
  private readonly baseRoot: string;
  private readonly secretsRoot: string;
  private readonly inFlightBases = new Map<string, Promise<string>>();
  private readonly worktreeLocks = new Map<string, Promise<void>>();

  constructor(sessionRoot: string, baseRoot?: string, secretsRoot?: string) {
    this.sessionRoot = sessionRoot;
    this.baseRoot = baseRoot ?? path.join(path.dirname(sessionRoot), "bases");
    this.secretsRoot = secretsRoot ?? path.join(path.dirname(sessionRoot), "secrets");
  }

  private async withWorktreeLock<T>(basePath: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.worktreeLocks.get(basePath) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.worktreeLocks.set(
      basePath,
      prev.then(() => current),
    );
    try {
      await prev;
      return await fn();
    } finally {
      release();
      if (this.worktreeLocks.get(basePath) === current) {
        this.worktreeLocks.delete(basePath);
      }
    }
  }

  async ensureAuthKeyFile(
    project: ProjectConfig,
    repo: RepositoryConfig,
    auth: RepoAuthConfig,
  ): Promise<{ keyPath: string; sshCommand: string } | undefined> {
    if (auth.type !== "ssh-key") return undefined;

    let rawKey =
      auth.key ??
      auth.keyContent ??
      (auth.keyEnv ? (project.env?.[auth.keyEnv] ?? process.env[auth.keyEnv]) : undefined) ??
      (auth.keyContentEnv
        ? (project.env?.[auth.keyContentEnv] ?? process.env[auth.keyContentEnv])
        : undefined);

    if (!rawKey && auth.keyPath) {
      return {
        keyPath: auth.keyPath,
        sshCommand: `ssh -i "${auth.keyPath}" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`,
      };
    }

    if (!rawKey) return undefined;

    rawKey = rawKey.trim();

    if (rawKey.startsWith("{env:")) {
      // Env var not resolved or unconfigured; fallback to system default SSH
      return undefined;
    }

    if (existsSync(rawKey)) {
      return {
        keyPath: rawKey,
        sshCommand: `ssh -i "${rawKey}" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`,
      };
    }

    let keyContent = rawKey;
    if (!rawKey.includes("-----BEGIN") && /^[A-Za-z0-9+/=\r\n]+$/.test(rawKey)) {
      try {
        const decoded = Buffer.from(rawKey, "base64").toString("utf-8");
        if (decoded.includes("-----BEGIN")) {
          keyContent = decoded;
        }
      } catch {}
    }

    if (!keyContent.endsWith("\n")) {
      keyContent += "\n";
    }

    const projectSecretsDir = path.join(this.secretsRoot, safe(project.id));
    await mkdir(projectSecretsDir, { recursive: true, mode: 0o700 });
    const keyFilePath = path.join(projectSecretsDir, `${safe(repo.id)}.id_key`);

    await Bun.write(keyFilePath, keyContent);
    await chmod(keyFilePath, 0o600);

    return {
      keyPath: keyFilePath,
      sshCommand: `ssh -i "${keyFilePath}" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`,
    };
  }

  async runLifecycleScript(
    project: ProjectConfig,
    action: "init" | "sync",
  ): Promise<boolean> {
    if (!project.projectDir) return false;
    const scriptPath = path.join(project.projectDir, "scripts", `${action}.sh`);
    if (!existsSync(scriptPath)) return false;

    await chmod(scriptPath, 0o755).catch(() => {});

    const env: Record<string, string | undefined> = {
      ...process.env,
      ...(project.env ?? {}),
    };

    const dotenvPath = path.join(project.projectDir, ".env");
    if (existsSync(dotenvPath)) {
      try {
        const raw = await Bun.file(dotenvPath).text();
        for (const line of raw.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          const idx = trimmed.indexOf("=");
          if (idx > 0) {
            const k = trimmed.slice(0, idx).trim();
            const v = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
            env[k] = v;
          }
        }
      } catch {}
    }

    try {
      const proc = Bun.spawn(["bash", scriptPath], {
        cwd: project.projectDir,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0) {
        console.warn(
          `[workspace] Warning: scripts/${action}.sh for project ${project.id} exited with code ${code}: ${stderr.trim()}`,
        );
        return false;
      }
      return true;
    } catch (err) {
      console.warn(
        `[workspace] Warning: Failed to execute scripts/${action}.sh for project ${project.id}:`,
        (err as Error).message,
      );
      return false;
    }
  }

  getBasePath(project: ProjectConfig, repository: RepositoryConfig): string {
    if (project.projectDir) {
      const localRepoInProject = path.resolve(project.projectDir, "repos", repository.id);
      if (existsSync(path.join(localRepoInProject, ".git"))) {
        return localRepoInProject;
      }
      if (
        repository.url &&
        !repository.url.startsWith("http://") &&
        !repository.url.startsWith("https://") &&
        !repository.url.startsWith("git@") &&
        !repository.url.startsWith("ssh://")
      ) {
        const directLocal = path.resolve(project.projectDir, repository.url);
        if (existsSync(path.join(directLocal, ".git"))) {
          return directLocal;
        }
      }
    }
    return path.join(this.baseRoot, safe(project.id), safe(repository.id));
  }

  getSessionRoot(project: ProjectConfig, sessionId: string): string {
    return path.join(this.sessionRoot, safe(project.id), safe(sessionId));
  }

  getSessionRepoPath(
    project: ProjectConfig,
    sessionId: string,
    repository: RepositoryConfig,
  ): string {
    return path.join(this.getSessionRoot(project, sessionId), safe(repository.id));
  }

  async ensureBase(project: ProjectConfig, repository: RepositoryConfig): Promise<string> {
    const key = `${safe(project.id)}/${safe(repository.id)}`;
    const existing = this.inFlightBases.get(key);
    if (existing) {
      return existing;
    }

    const task = this.syncBaseRepo(project, repository).finally(() => {
      this.inFlightBases.delete(key);
    });

    this.inFlightBases.set(key, task);
    return task;
  }

  private async syncBaseRepo(
    project: ProjectConfig,
    repository: RepositoryConfig,
  ): Promise<string> {
    const basePath = this.getBasePath(project, repository);
    return await this.withWorktreeLock(basePath, async () => {
      await mkdir(path.dirname(basePath), { recursive: true, mode: 0o750 });

      const effectiveAuth = repository.auth ?? project.auth;
      let authKeyInfo: { keyPath: string; sshCommand: string } | undefined;
      if (effectiveAuth) {
        authKeyInfo = await this.ensureAuthKeyFile(project, repository, effectiveAuth);
      }
      const authEnv = resolveGitAuthEnv(effectiveAuth, authKeyInfo?.keyPath);

      if (!repository.url) {
        await mkdir(basePath, { recursive: true });
        return basePath;
      }

      const resolvedUrl =
        repository.url.startsWith("http://") ||
        repository.url.startsWith("https://") ||
        repository.url.startsWith("git@") ||
        repository.url.startsWith("ssh://")
          ? repository.url
          : path.resolve(project.projectDir ?? process.cwd(), repository.url);

      let isGitRepo = false;
      try {
        await access(path.join(basePath, ".git"));
        isGitRepo = true;
      } catch {
        isGitRepo = false;
      }

      if (isGitRepo) {
        // If scripts/sync.sh exists, lifecycle sync is handled by sync.sh; otherwise fallback to git fetch/pull
        const hasSyncScript =
          project.projectDir &&
          existsSync(path.join(project.projectDir, "scripts", "sync.sh"));
        if (!hasSyncScript) {
          try {
            await run("git", ["fetch", "--all", "--prune"], basePath, authEnv);
            const originRef = `origin/${repository.baseBranch}`;
            try {
              await run("git", ["rev-parse", "--verify", originRef], basePath);
              try {
                await run("git", ["merge", "--ff-only", originRef], basePath);
              } catch {
                await run("git", ["reset", "--hard", originRef], basePath);
              }
            } catch {}
            await run("git", ["worktree", "prune"], basePath);
          } catch (err) {
            console.warn(
              `[workspace] Warning: Failed to pull latest code for ${project.id}/${repository.id}, using cached version:`,
              (err as Error).message,
            );
          }
        }
      } else {
        // First run: delegate repository initialization and clone to scripts/init.sh
        const ranInit = await this.runLifecycleScript(project, "init");
        try {
          await access(path.join(basePath, ".git"));
          isGitRepo = true;
        } catch {
          isGitRepo = false;
        }

        // Fallback to basic clone if init.sh script is missing (e.g. In unit test suites)
        if (!isGitRepo && !ranInit && repository.url) {
          await run(
            "git",
            ["clone", "--single-branch", "--branch", repository.baseBranch, resolvedUrl, basePath],
            undefined,
            authEnv,
          );
        }
      }

      const committer = resolveCommitter(project, repository);
      await run("git", ["config", "user.name", committer.name], basePath);
      await run("git", ["config", "user.email", committer.email], basePath);

      if (authKeyInfo) {
        await run("git", ["config", "core.sshCommand", authKeyInfo.sshCommand], basePath);
      } else if (effectiveAuth?.type === "token") {
        const token =
          effectiveAuth.token ??
          (effectiveAuth.tokenEnv
            ? (project.env?.[effectiveAuth.tokenEnv] ?? process.env[effectiveAuth.tokenEnv])
            : undefined);
        if (token) {
          await run(
            "git",
            ["config", "http.extraheader", `Authorization: Bearer ${token}`],
            basePath,
          );
        }
      }

      return basePath;
    });
  }

  async syncAllBases(project: ProjectConfig): Promise<void> {
    // Run sync.sh prior to initial startup and pre-warm
    await this.runLifecycleScript(project, "sync");
    for (const repo of project.repositories) {
      await this.ensureBase(project, repo);
    }
  }

  async ensureSessionWorkspaces(
    project: ProjectConfig,
    sessionId: string,
  ): Promise<SessionWorkspaceInfo> {
    if (project.id === GLOBAL_PROJECT_ID || project.repositories.length === 0) {
      const globalPath = project.projectDir || path.resolve(process.cwd(), "projects");
      await mkdir(globalPath, { recursive: true, mode: 0o750 });

      // Ensure AGENTS.md exists in global workspace with instructions
      const agentsMdPath = path.join(globalPath, "AGENTS.md");
      if (!existsSync(agentsMdPath)) {
        await Bun.write(agentsMdPath, DEFAULT_GLOBAL_PROMPT).catch(() => {});
      }

      return {
        sessionRoot: globalPath,
        repoPaths: new Map(),
        primaryPath: globalPath,
      };
    }

    // Run sync.sh to synchronize latest project code before starting session workspace
    await this.runLifecycleScript(project, "sync");

    const sessionRoot = this.getSessionRoot(project, sessionId);
    await mkdir(sessionRoot, { recursive: true, mode: 0o750 });

    const repoPaths = new Map<string, string>();
    const branchName = `agent/${safe(sessionId)}`;
    let primaryPath = "";

    for (const repo of project.repositories) {
      const repoPath = this.getSessionRepoPath(project, sessionId, repo);
      const basePath = await this.ensureBase(project, repo);

      if (!repo.url) {
        await mkdir(repoPath, { recursive: true });
        repoPaths.set(repo.id, repoPath);
        if (repo.isPrimary || !primaryPath) primaryPath = repoPath;
        continue;
      }

      await this.withWorktreeLock(basePath, async () => {
        try {
          await access(path.join(repoPath, ".git"));
        } catch {
          await mkdir(path.dirname(repoPath), { recursive: true, mode: 0o750 });
          let startPoint = `origin/${repo.baseBranch}`;
          try {
            await run("git", ["rev-parse", "--verify", startPoint], basePath);
          } catch {
            startPoint = repo.baseBranch;
          }

          await run("git", ["worktree", "add", "-B", branchName, repoPath, startPoint], basePath);
        }
      });

      const committer = resolveCommitter(project, repo);
      await run("git", ["config", "user.name", committer.name], repoPath);
      await run("git", ["config", "user.email", committer.email], repoPath);

      const effectiveAuth = repo.auth ?? project.auth;
      if (effectiveAuth) {
        const authKeyInfo = await this.ensureAuthKeyFile(project, repo, effectiveAuth);
        if (authKeyInfo) {
          await run("git", ["config", "core.sshCommand", authKeyInfo.sshCommand], repoPath);
        } else if (effectiveAuth.type === "token") {
          const token =
            effectiveAuth.token ??
            (effectiveAuth.tokenEnv
              ? (project.env?.[effectiveAuth.tokenEnv] ?? process.env[effectiveAuth.tokenEnv])
              : undefined);
          if (token) {
            await run(
              "git",
              ["config", "http.extraheader", `Authorization: Bearer ${token}`],
              repoPath,
            );
          }
        }
      }

      repoPaths.set(repo.id, repoPath);
      if (repo.isPrimary || !primaryPath) primaryPath = repoPath;
    }

    return {
      sessionRoot,
      repoPaths,
      primaryPath: primaryPath || sessionRoot,
    };
  }

  async removeSession(project: ProjectConfig, sessionId: string): Promise<void> {
    if (project.id === GLOBAL_PROJECT_ID || project.repositories.length === 0) {
      return;
    }
    const sessionRoot = this.getSessionRoot(project, sessionId);
    for (const repo of project.repositories) {
      const repoPath = this.getSessionRepoPath(project, sessionId, repo);
      const basePath = this.getBasePath(project, repo);
      await this.withWorktreeLock(basePath, async () => {
        try {
          await run("git", ["worktree", "remove", "--force", repoPath], basePath);
          await run("git", ["worktree", "prune"], basePath);
        } catch {}
      });
    }
    await rm(sessionRoot, { recursive: true, force: true });
  }

  async ensure(
    project: ProjectConfig,
    sessionId: string,
    repository?: RepositoryConfig,
  ): Promise<string> {
    const info = await this.ensureSessionWorkspaces(project, sessionId);
    if (repository && info.repoPaths.has(repository.id)) {
      return info.repoPaths.get(repository.id)!;
    }
    return info.primaryPath;
  }

  async branch(workspace: string, sessionId: string): Promise<string> {
    const branch = `agent/${safe(sessionId)}`;
    try {
      await run("git", ["switch", branch], workspace);
    } catch {}
    return branch;
  }
}
