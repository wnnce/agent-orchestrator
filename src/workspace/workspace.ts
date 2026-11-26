import path from "node:path";
import { mkdir, rm, chmod } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import type { ProjectConfig, RepositoryConfig, RepoAuthConfig } from "../domain/types.ts";
import { GLOBAL_PROJECT_ID, DEFAULT_GLOBAL_PROMPT } from "../project/global.ts";
import { Logger } from "../observability/logger.ts";

function safe(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(value))
    throw new Error(`unsafe path component: ${value}`);
  return value;
}

function isRemoteUrl(url: string): boolean {
  return (
    url.startsWith("http://") ||
    url.startsWith("https://") ||
    url.startsWith("git@") ||
    url.startsWith("ssh://")
  );
}

function sshCommand(keyPath: string): string {
  return `ssh -i "${keyPath}" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
}

export function resolveCommitter(repo?: RepositoryConfig): { name: string; email: string } {
  const name =
    repo?.committer?.name?.trim() || process.env.GIT_AUTHOR_NAME?.trim() || "Agent Orchestrator";

  const email =
    repo?.committer?.email?.trim() ||
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
    env.GIT_SSH_COMMAND = keyPath ? sshCommand(keyPath) : "ssh -o StrictHostKeyChecking=accept-new";
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

async function refExists(repoPath: string, ref: string): Promise<boolean> {
  return run("git", ["rev-parse", "--verify", "--quiet", ref], repoPath).then(
    () => true,
    () => false,
  );
}

/**
 * Manages each project's base repository and the per-session git worktrees made from it.
 *
 * A project has at most one repository. A session works in its own worktree of it, on branch
 * `agent/<sessionId>`; the global project and projects without a repository share one directory.
 * A repository with an empty `url` gives each session a plain directory without git.
 *
 * Path lookups (`sessionPath`, `isSessionReady`) never run git. Only `syncBase` (service start)
 * and `ensureSessionWorkspace` (session creation, or a missing worktree) fetch the base
 * repository and run the project's `scripts/sync.sh`.
 */
export class WorkspaceManager {
  private readonly sessionRoot: string;
  private readonly pipelineRoot: string;
  private readonly baseRoot: string;
  private readonly secretsRoot: string;
  private readonly inFlightBases = new Map<string, Promise<string>>();
  private readonly worktreeLocks = new Map<string, Promise<void>>();

  constructor(
    sessionRoot: string,
    baseRoot?: string,
    secretsRoot?: string,
    private readonly logger = new Logger(),
    pipelineRoot?: string,
  ) {
    this.sessionRoot = sessionRoot;
    this.pipelineRoot = pipelineRoot ?? path.join(path.dirname(sessionRoot), "pipelines");
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
      return { keyPath: auth.keyPath, sshCommand: sshCommand(auth.keyPath) };
    }
    if (!rawKey) return undefined;

    rawKey = rawKey.trim();
    // An `{env:NAME}` placeholder that config loading could not resolve: use the default SSH setup.
    if (rawKey.startsWith("{env:")) return undefined;

    if (existsSync(rawKey)) {
      return { keyPath: rawKey, sshCommand: sshCommand(rawKey) };
    }

    // The key may be given inline either as PEM text or base64-encoded PEM.
    let keyContent = rawKey;
    if (!rawKey.includes("-----BEGIN") && /^[A-Za-z0-9+/=\r\n]+$/.test(rawKey)) {
      const decoded = Buffer.from(rawKey, "base64").toString("utf-8");
      if (decoded.includes("-----BEGIN")) keyContent = decoded;
    }
    if (!keyContent.endsWith("\n")) keyContent += "\n";

    await mkdir(this.secretsRoot, { recursive: true, mode: 0o700 });
    const keyFilePath = path.join(this.secretsRoot, `${safe(project.id)}.id_key`);
    await Bun.write(keyFilePath, keyContent);
    await chmod(keyFilePath, 0o600);

    return { keyPath: keyFilePath, sshCommand: sshCommand(keyFilePath) };
  }

  /**
   * Runs the project's optional `scripts/<action>.sh` from the project directory. Returns false
   * when the project has no such script and throws when the script fails.
   */
  private async runLifecycleScript(
    project: ProjectConfig,
    action: "init" | "sync",
  ): Promise<boolean> {
    if (!project.projectDir) return false;
    const scriptPath = path.join(project.projectDir, "scripts", `${action}.sh`);
    if (!existsSync(scriptPath)) return false;

    const proc = Bun.spawn(["bash", scriptPath], {
      cwd: project.projectDir,
      // project.env already includes the project's .env file (see config loading).
      env: { ...process.env, ...(project.env ?? {}) },
      stdout: "ignore",
      stderr: "pipe",
    });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) {
      throw new Error(`scripts/${action}.sh exited with code ${code}: ${stderr.trim()}`);
    }
    return true;
  }

  /** scripts/sync.sh is best effort: when it fails, sessions use the base repository as it is. */
  private async runSyncScript(project: ProjectConfig): Promise<void> {
    try {
      await this.runLifecycleScript(project, "sync");
    } catch (error) {
      this.logger.warn("project sync script failed; using the base repository as it is", {
        projectId: project.id,
        error: (error as Error).message,
      });
    }
  }

  /**
   * The base repository that session worktrees are made from: the repository's `path` (relative
   * to the project directory) when set, else `<data>/bases/<projectId>`.
   */
  getBasePath(project: ProjectConfig, repository: RepositoryConfig): string {
    if (repository.path) {
      return path.resolve(project.projectDir ?? process.cwd(), repository.path);
    }
    return path.join(this.baseRoot, safe(project.id));
  }

  /** The session's working directory. Never runs git. */
  sessionPath(project: ProjectConfig, sessionId: string): string {
    if (usesSharedWorkspace(project)) return sharedWorkspacePath(project);
    const root = path.join(this.sessionRoot, safe(project.id), safe(sessionId));
    if (existsSync(path.join(root, ".git"))) return root;
    return legacyWorktreePath(root) ?? root;
  }

  /** Whether the session's worktree is on disk. */
  isSessionReady(project: ProjectConfig, sessionId: string): boolean {
    const workspace = this.sessionPath(project, sessionId);
    if (usesSharedWorkspace(project) || !project.repository?.url) return existsSync(workspace);
    return existsSync(path.join(workspace, ".git"));
  }

  async ensureBase(project: ProjectConfig, repository: RepositoryConfig): Promise<string> {
    const key = safe(project.id);
    const existing = this.inFlightBases.get(key);
    if (existing) return existing;

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

      const auth = repository.auth;
      const authKeyInfo = auth ? await this.ensureAuthKeyFile(project, auth) : undefined;
      const authEnv = resolveGitAuthEnv(auth, authKeyInfo?.keyPath);

      if (!repository.url) {
        await mkdir(basePath, { recursive: true });
        return basePath;
      }

      if (existsSync(path.join(basePath, ".git"))) {
        // A project with scripts/sync.sh keeps its base repository up to date itself.
        const hasSyncScript =
          project.projectDir && existsSync(path.join(project.projectDir, "scripts", "sync.sh"));
        if (!hasSyncScript) await this.pullBase(project, repository, basePath, authEnv);
      } else if (await this.runLifecycleScript(project, "init")) {
        // A project with scripts/init.sh makes the first checkout of its repository itself.
        if (!existsSync(path.join(basePath, ".git"))) {
          throw new Error(`scripts/init.sh did not create the repository at ${basePath}`);
        }
      } else {
        const resolvedUrl = isRemoteUrl(repository.url)
          ? repository.url
          : path.resolve(project.projectDir ?? process.cwd(), repository.url);
        await run(
          "git",
          ["clone", "--single-branch", "--branch", repository.baseBranch, resolvedUrl, basePath],
          undefined,
          authEnv,
        );
      }

      // Worktrees share the base repository's config, so identity and auth are set once here.
      const committer = resolveCommitter(repository);
      await run("git", ["config", "user.name", committer.name], basePath);
      await run("git", ["config", "user.email", committer.email], basePath);
      if (authKeyInfo) {
        await run("git", ["config", "core.sshCommand", authKeyInfo.sshCommand], basePath);
      } else if (auth?.type === "token") {
        const token =
          auth.token ??
          (auth.tokenEnv ? (project.env?.[auth.tokenEnv] ?? process.env[auth.tokenEnv]) : undefined);
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

  /** Fast-forwards the base repository to its remote branch; a failed pull keeps the cached copy. */
  private async pullBase(
    project: ProjectConfig,
    repository: RepositoryConfig,
    basePath: string,
    authEnv: Record<string, string>,
  ): Promise<void> {
    const originRef = `origin/${repository.baseBranch}`;
    try {
      await run("git", ["fetch", "--all", "--prune"], basePath, authEnv);
      if (await refExists(basePath, originRef)) {
        try {
          await run("git", ["merge", "--ff-only", originRef], basePath);
        } catch {
          await run("git", ["reset", "--hard", originRef], basePath);
        }
      }
      await run("git", ["worktree", "prune"], basePath);
    } catch (error) {
      this.logger.warn("failed to update base repository; using cached copy", {
        projectId: project.id,
        error,
      });
    }
  }

  /** Service start: run scripts/sync.sh and bring the base repository up to date. */
  async syncBase(project: ProjectConfig): Promise<void> {
    await this.runSyncScript(project);
    if (project.repository) await this.ensureBase(project, project.repository);
  }

  /**
   * Creates the session's workspace and returns its path: syncs the base repository and adds a
   * worktree on branch `agent/<sessionId>`. An existing worktree is kept as it is.
   */
  async ensureSessionWorkspace(project: ProjectConfig, sessionId: string): Promise<string> {
    const workspace = this.sessionPath(project, sessionId);
    if (usesSharedWorkspace(project)) {
      await mkdir(workspace, { recursive: true, mode: 0o750 });
      const agentsMdPath = path.join(workspace, "AGENTS.md");
      if (!existsSync(agentsMdPath)) await Bun.write(agentsMdPath, DEFAULT_GLOBAL_PROMPT);
      return workspace;
    }
    await this.ensureWorktree(project, workspace, `agent/${safe(sessionId)}`);
    return workspace;
  }

  async removeSession(project: ProjectConfig, sessionId: string): Promise<void> {
    if (usesSharedWorkspace(project)) return;
    await this.removeWorktree(
      project,
      this.sessionPath(project, sessionId),
      path.join(this.sessionRoot, safe(project.id), safe(sessionId)),
    );
  }

  /** The working directory shared by all nodes of a PipelineRun. Never runs git. */
  pipelinePath(project: ProjectConfig, runId: string): string {
    if (usesSharedWorkspace(project)) return sharedWorkspacePath(project);
    return path.join(this.pipelineRoot, safe(project.id), safe(runId));
  }

  /**
   * Creates the shared workspace of a PipelineRun, a worktree on branch `pipeline/<runId>`. An
   * existing worktree is kept as it is, so every node of the run works on the same changes.
   */
  async ensurePipelineWorkspace(
    project: ProjectConfig,
    runId: string,
  ): Promise<{ workspacePath: string; branchName?: string | undefined }> {
    const workspacePath = this.pipelinePath(project, runId);
    if (usesSharedWorkspace(project)) {
      await mkdir(workspacePath, { recursive: true, mode: 0o750 });
      return { workspacePath };
    }
    const branchName = `pipeline/${safe(runId)}`;
    const isGit = await this.ensureWorktree(project, workspacePath, branchName);
    return isGit ? { workspacePath, branchName } : { workspacePath };
  }

  /** Removes the shared workspace of a completed or cancelled PipelineRun. */
  async removePipelineWorkspace(project: ProjectConfig, runId: string): Promise<void> {
    if (usesSharedWorkspace(project)) return;
    const workspacePath = this.pipelinePath(project, runId);
    await this.removeWorktree(project, workspacePath, workspacePath);
  }

  /**
   * Makes `workspace` a worktree of the project's base repository on `branchName`, after running
   * scripts/sync.sh and syncing the base. A repository without a URL gets a plain directory.
   * Returns whether the workspace is a git worktree.
   */
  private async ensureWorktree(
    project: ProjectConfig,
    workspace: string,
    branchName: string,
  ): Promise<boolean> {
    const repository = project.repository!;
    await this.runSyncScript(project);
    const basePath = await this.ensureBase(project, repository);
    if (!repository.url) {
      await mkdir(workspace, { recursive: true, mode: 0o750 });
      return false;
    }
    await this.withWorktreeLock(basePath, async () => {
      if (existsSync(path.join(workspace, ".git"))) return;
      await mkdir(path.dirname(workspace), { recursive: true, mode: 0o750 });
      const originRef = `origin/${repository.baseBranch}`;
      const startPoint = (await refExists(basePath, originRef))
        ? originRef
        : repository.baseBranch;
      await run("git", ["worktree", "add", "-B", branchName, workspace, startPoint], basePath);
    });
    return true;
  }

  /**
   * Unregisters the worktree at `workspace` from the base repository and deletes `directory`
   * (the worktree itself, or the folder that contains it).
   */
  private async removeWorktree(
    project: ProjectConfig,
    workspace: string,
    directory: string,
  ): Promise<void> {
    const repository = project.repository!;
    if (repository.url && existsSync(workspace)) {
      const basePath = this.getBasePath(project, repository);
      await this.withWorktreeLock(basePath, async () => {
        try {
          await run("git", ["worktree", "remove", "--force", workspace], basePath);
          await run("git", ["worktree", "prune"], basePath);
        } catch (error) {
          this.logger.warn("failed to remove worktree", {
            projectId: project.id,
            workspace,
            error,
          });
        }
      });
    }
    await rm(directory, { recursive: true, force: true });
  }
}

/** The global project and repository-less projects share one directory instead of worktrees. */
function usesSharedWorkspace(project: ProjectConfig): boolean {
  return project.id === GLOBAL_PROJECT_ID || !project.repository;
}

/**
 * Sessions created while projects could have several repositories keep their worktree one level
 * down, in `<session>/<repositoryId>`.
 */
function legacyWorktreePath(sessionRoot: string): string | undefined {
  if (!existsSync(sessionRoot)) return undefined;
  const entry = readdirSync(sessionRoot, { withFileTypes: true }).find(
    (e) => e.isDirectory() && existsSync(path.join(sessionRoot, e.name, ".git")),
  );
  return entry && path.join(sessionRoot, entry.name);
}

function sharedWorkspacePath(project: ProjectConfig): string {
  return project.projectDir || path.resolve(process.cwd(), "projects");
}
