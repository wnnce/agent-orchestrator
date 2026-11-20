import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { WorkspaceManager, resolveGitAuthEnv } from "../src/workspace/workspace.ts";
import type { ProjectConfig } from "../src/domain/types.ts";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

describe("resolveGitAuthEnv", () => {
  test("generates SSH command when ssh-key path is provided", () => {
    const env = resolveGitAuthEnv({
      type: "ssh-key",
      keyPath: "/keys/id_ed25519",
    });
    expect(env.GIT_SSH_COMMAND).toBe(
      'ssh -i "/keys/id_ed25519" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new',
    );
  });

  test("generates SSH command from keyEnv", () => {
    process.env.TEST_GIT_KEY = "/secrets/custom_key";
    try {
      const env = resolveGitAuthEnv({
        type: "ssh-key",
        keyEnv: "TEST_GIT_KEY",
      });
      expect(env.GIT_SSH_COMMAND).toContain("/secrets/custom_key");
    } finally {
      delete process.env.TEST_GIT_KEY;
    }
  });

  test("generates git http extraheader for token auth", () => {
    const env = resolveGitAuthEnv({
      type: "token",
      token: "ghp_secret_token_123",
    });
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.extraheader");
    expect(env.GIT_CONFIG_VALUE_0).toBe("Authorization: Bearer ghp_secret_token_123");
  });

  test("generates token auth from tokenEnv", () => {
    process.env.TEST_GIT_TOKEN = "glpat-xyz789";
    try {
      const env = resolveGitAuthEnv({
        type: "token",
        tokenEnv: "TEST_GIT_TOKEN",
      });
      expect(env.GIT_CONFIG_VALUE_0).toBe("Authorization: Bearer glpat-xyz789");
    } finally {
      delete process.env.TEST_GIT_TOKEN;
    }
  });
});

describe("WorkspaceManager worktree isolation", () => {
  let tempDir: string;
  let remoteDir: string;
  let sessionRootDir: string;
  let baseRootDir: string;
  let manager: WorkspaceManager;
  let testProject: ProjectConfig;

  async function git(cmdArgs: string[], cwd: string): Promise<string> {
    const proc = Bun.spawn(["git", ...cmdArgs], { cwd, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      throw new Error(`git ${cmdArgs.join(" ")} failed (${code}): ${stderr}`);
    }
    return stdout.trim();
  }

  async function commit(file: string, content: string): Promise<void> {
    await writeFile(path.join(remoteDir, file), content);
    await git(["add", file], remoteDir);
    await git(["commit", "-m", `add ${file}`], remoteDir);
  }

  beforeEach(async () => {
    tempDir = path.join("/tmp", `workspace-test-${crypto.randomUUID()}`);
    remoteDir = path.join(tempDir, "remote");
    sessionRootDir = path.join(tempDir, "sessions");
    baseRootDir = path.join(tempDir, "bases");

    await mkdir(remoteDir, { recursive: true });
    await git(["init", "-b", "main"], remoteDir);
    await git(["config", "user.name", "Tester"], remoteDir);
    await git(["config", "user.email", "test@example.com"], remoteDir);
    await commit("backend.txt", "hello backend");

    manager = new WorkspaceManager(sessionRootDir, baseRootDir);
    testProject = {
      id: "service",
      displayName: "Service",
      description: "Testing worktrees",
      projectDir: path.join(tempDir, "project"),
      routing: { projectId: "service" },
      repository: { url: remoteDir, baseBranch: "main" },
    };
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("syncBase clones the base repository", async () => {
    await manager.syncBase(testProject);
    const basePath = manager.getBasePath(testProject, testProject.repository!);
    expect(basePath).toBe(path.join(baseRootDir, "service"));
    expect(existsSync(path.join(basePath, ".git"))).toBe(true);
  });

  test("a session works in its own worktree on its own branch", async () => {
    const sessionId = "ses-12345";
    const workspace = await manager.ensureSessionWorkspace(testProject, sessionId);

    expect(workspace).toBe(path.join(sessionRootDir, "service", sessionId));
    expect(manager.sessionPath(testProject, sessionId)).toBe(workspace);
    expect(manager.isSessionReady(testProject, sessionId)).toBe(true);
    expect(await git(["branch", "--show-current"], workspace)).toBe(`agent/${sessionId}`);
    expect(await Bun.file(path.join(workspace, "backend.txt")).text()).toBe("hello backend");
  });

  test("concurrent sessions are completely isolated from each other and base", async () => {
    const pathA = await manager.ensureSessionWorkspace(testProject, "ses-aaa");
    const pathB = await manager.ensureSessionWorkspace(testProject, "ses-bbb");

    await writeFile(path.join(pathA, "feature-a.txt"), "feature A in session A");
    await git(["add", "feature-a.txt"], pathA);
    await git(["commit", "-m", "add feature A"], pathA);

    expect(await Bun.file(path.join(pathA, "feature-a.txt")).exists()).toBe(true);
    expect(await Bun.file(path.join(pathB, "feature-a.txt")).exists()).toBe(false);
    const basePath = manager.getBasePath(testProject, testProject.repository!);
    expect(await Bun.file(path.join(basePath, "feature-a.txt")).exists()).toBe(false);
  });

  test("removeSession removes the worktree and the session directory", async () => {
    const sessionId = "ses-cleanup";
    const workspace = await manager.ensureSessionWorkspace(testProject, sessionId);
    expect(existsSync(workspace)).toBe(true);

    await manager.removeSession(testProject, sessionId);

    expect(existsSync(workspace)).toBe(false);
    const basePath = manager.getBasePath(testProject, testProject.repository!);
    expect(await git(["worktree", "list"], basePath)).not.toContain(sessionId);
  });

  test("a local checkout named by repository.path is used as the base", async () => {
    const checkout = path.join(testProject.projectDir!, "repo");
    await mkdir(testProject.projectDir!, { recursive: true });
    await git(["clone", "-q", remoteDir, checkout], tempDir);
    const project = { ...testProject, repository: { ...testProject.repository!, path: "repo" } };

    expect(manager.getBasePath(project, project.repository)).toBe(checkout);
    const workspace = await manager.ensureSessionWorkspace(project, "ses-local");
    expect(await git(["worktree", "list"], checkout)).toContain(workspace);
    expect(existsSync(path.join(baseRootDir, "service"))).toBe(false);
  });

  test("scripts/init.sh makes the first checkout instead of the orchestrator", async () => {
    const scripts = path.join(testProject.projectDir!, "scripts");
    await mkdir(scripts, { recursive: true });
    await writeFile(
      path.join(scripts, "init.sh"),
      `#!/usr/bin/env bash\nset -e\ngit clone -q ${remoteDir} repos/service\n`,
    );
    const project = {
      ...testProject,
      repository: { ...testProject.repository!, path: "repos/service" },
    };

    const workspace = await manager.ensureSessionWorkspace(project, "ses-init");
    expect(await Bun.file(path.join(workspace, "backend.txt")).text()).toBe("hello backend");
  });

  test("a failing scripts/init.sh fails the base setup with its error", async () => {
    const scripts = path.join(testProject.projectDir!, "scripts");
    await mkdir(scripts, { recursive: true });
    await writeFile(
      path.join(scripts, "init.sh"),
      "#!/usr/bin/env bash\necho 'Permission denied (publickey)' >&2\nexit 128\n",
    );
    const project = {
      ...testProject,
      repository: { ...testProject.repository!, path: "repos/service" },
    };

    await expect(manager.ensureSessionWorkspace(project, "ses-init")).rejects.toThrow(
      "scripts/init.sh exited with code 128: Permission denied (publickey)",
    );
  });

  test("scripts/init.sh that does not create the repository is an error, not a fallback clone", async () => {
    const scripts = path.join(testProject.projectDir!, "scripts");
    await mkdir(scripts, { recursive: true });
    await writeFile(path.join(scripts, "init.sh"), "#!/usr/bin/env bash\nmkdir -p repos\n");
    const project = {
      ...testProject,
      repository: { ...testProject.repository!, path: "repos/service" },
    };

    await expect(manager.ensureSessionWorkspace(project, "ses-init")).rejects.toThrow(
      "scripts/init.sh did not create the repository",
    );
    expect(existsSync(path.join(testProject.projectDir!, "repos", "service"))).toBe(false);
  });

  test("single-flight coalesces concurrent ensureBase requests", async () => {
    const repo = testProject.repository!;
    const [path1, path2, path3] = await Promise.all([
      manager.ensureBase(testProject, repo),
      manager.ensureBase(testProject, repo),
      manager.ensureBase(testProject, repo),
    ]);
    expect(path1).toBe(path2);
    expect(path2).toBe(path3);
    expect(existsSync(path.join(path1, ".git"))).toBe(true);
  });

  test("a new session starts from the latest upstream commit", async () => {
    const first = await manager.ensureSessionWorkspace(testProject, "ses-1");
    expect(existsSync(path.join(first, "new-feature.txt"))).toBe(false);

    await commit("new-feature.txt", "latest upstream code");

    const second = await manager.ensureSessionWorkspace(testProject, "ses-2");
    expect(await Bun.file(path.join(second, "new-feature.txt")).text()).toBe(
      "latest upstream code",
    );
  });

  test("sessions created concurrently all get a worktree of the latest commit", async () => {
    await commit("concurrent.txt", "concurrent test content");
    const sessionIds = ["ses-c1", "ses-c2", "ses-c3", "ses-c4", "ses-c5"];
    const workspaces = await Promise.all(
      sessionIds.map((id) => manager.ensureSessionWorkspace(testProject, id)),
    );
    for (const workspace of workspaces) {
      expect(existsSync(path.join(workspace, "concurrent.txt"))).toBe(true);
    }
  });
});
