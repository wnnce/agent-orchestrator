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

describe("WorkspaceManager multi-repo and worktree isolation", () => {
  let tempDir: string;
  let repo1Dir: string;
  let repo2Dir: string;
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

  beforeEach(async () => {
    tempDir = path.join("/tmp", `workspace-test-${crypto.randomUUID()}`);
    repo1Dir = path.join(tempDir, "remote-backend");
    repo2Dir = path.join(tempDir, "remote-proto");
    sessionRootDir = path.join(tempDir, "projects");
    baseRootDir = path.join(tempDir, "bases");

    await mkdir(repo1Dir, { recursive: true });
    await mkdir(repo2Dir, { recursive: true });

    // Initialize remote-backend
    await git(["init", "-b", "main"], repo1Dir);
    await git(["config", "user.name", "Tester"], repo1Dir);
    await git(["config", "user.email", "test@example.com"], repo1Dir);
    await writeFile(path.join(repo1Dir, "backend.txt"), "hello backend");
    await git(["add", "backend.txt"], repo1Dir);
    await git(["commit", "-m", "initial backend commit"], repo1Dir);

    // Initialize remote-proto
    await git(["init", "-b", "master"], repo2Dir);
    await git(["config", "user.name", "Tester"], repo2Dir);
    await git(["config", "user.email", "test@example.com"], repo2Dir);
    await writeFile(path.join(repo2Dir, "schema.proto"), "syntax = proto3;");
    await git(["add", "schema.proto"], repo2Dir);
    await git(["commit", "-m", "initial proto commit"], repo2Dir);

    manager = new WorkspaceManager(sessionRootDir, baseRootDir);

    testProject = {
      id: "multi-project",
      displayName: "Multi Project",
      description: "Testing multi-repo worktrees",
      routing: { projectId: "multi-project" },
      repositories: [
        {
          id: "service",
          url: repo1Dir,
          baseBranch: "main",
          isPrimary: true,
        },
        {
          id: "proto",
          url: repo2Dir,
          baseBranch: "master",
          isPrimary: false,
        },
      ],
    };
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("syncAllBases clones and pre-warms all base repositories", async () => {
    await manager.syncAllBases(testProject);

    const baseServicePath = manager.getBasePath(testProject, testProject.repositories[0]!);
    const baseProtoPath = manager.getBasePath(testProject, testProject.repositories[1]!);

    expect(existsSync(path.join(baseServicePath, ".git"))).toBe(true);
    expect(existsSync(path.join(baseProtoPath, ".git"))).toBe(true);
  });

  test("ensureSessionWorkspaces creates independent git worktrees for each repository", async () => {
    const sessionId = "ses-12345";
    const info = await manager.ensureSessionWorkspaces(testProject, sessionId);

    expect(info.repoPaths.size).toBe(2);
    const servicePath = info.repoPaths.get("service")!;
    const protoPath = info.repoPaths.get("proto")!;
    expect(info.primaryPath).toBe(servicePath);

    // Verify current branches in session worktrees
    const serviceBranch = await git(["branch", "--show-current"], servicePath);
    const protoBranch = await git(["branch", "--show-current"], protoPath);

    expect(serviceBranch).toBe(`agent/${sessionId}`);
    expect(protoBranch).toBe(`agent/${sessionId}`);

    // Verify files exist in session worktrees
    const file1 = await Bun.file(path.join(servicePath, "backend.txt")).text();
    const file2 = await Bun.file(path.join(protoPath, "schema.proto")).text();
    expect(file1).toBe("hello backend");
    expect(file2).toBe("syntax = proto3;");
  });

  test("concurrent sessions are completely isolated from each other and base", async () => {
    const sessionA = "ses-aaa";
    const sessionB = "ses-bbb";

    const infoA = await manager.ensureSessionWorkspaces(testProject, sessionA);
    const infoB = await manager.ensureSessionWorkspaces(testProject, sessionB);

    const pathA = infoA.repoPaths.get("service")!;
    const pathB = infoB.repoPaths.get("service")!;

    // Make and commit a change in session A
    await writeFile(path.join(pathA, "feature-a.txt"), "feature A in session A");
    await git(["add", "feature-a.txt"], pathA);
    await git(["commit", "-m", "add feature A"], pathA);

    // Verify session B and base do NOT see feature-a.txt
    expect(await Bun.file(path.join(pathA, "feature-a.txt")).exists()).toBe(true);
    expect(await Bun.file(path.join(pathB, "feature-a.txt")).exists()).toBe(false);

    const basePath = manager.getBasePath(testProject, testProject.repositories[0]!);
    expect(await Bun.file(path.join(basePath, "feature-a.txt")).exists()).toBe(false);
  });

  test("removeSession removes worktrees and session root directory", async () => {
    const sessionId = "ses-cleanup";
    const info = await manager.ensureSessionWorkspaces(testProject, sessionId);
    const servicePath = info.repoPaths.get("service")!;

    expect(existsSync(servicePath)).toBe(true);

    await manager.removeSession(testProject, sessionId);

    // Session directory should be completely gone
    expect(existsSync(info.sessionRoot)).toBe(false);

    // Base worktree list should no longer include the session worktree
    const basePath = manager.getBasePath(testProject, testProject.repositories[0]!);
    const worktrees = await git(["worktree", "list"], basePath);
    expect(worktrees).not.toContain(sessionId);
  });

  test("single-flight coalesces concurrent ensureBase requests", async () => {
    const repo = testProject.repositories[0]!;
    const [path1, path2, path3] = await Promise.all([
      manager.ensureBase(testProject, repo),
      manager.ensureBase(testProject, repo),
      manager.ensureBase(testProject, repo),
    ]);
    expect(path1).toBe(path2);
    expect(path2).toBe(path3);
    expect(existsSync(path.join(path1, ".git"))).toBe(true);
  });

  test("automatically pulls latest code when new workspace is created", async () => {
    // 1. Initial session
    const info1 = await manager.ensureSessionWorkspaces(testProject, "ses-1");
    const service1 = info1.repoPaths.get("service")!;
    expect(existsSync(path.join(service1, "new-feature.txt"))).toBe(false);

    // 2. Upstream origin commits a new file
    await writeFile(path.join(repo1Dir, "new-feature.txt"), "latest upstream code");
    await git(["add", "new-feature.txt"], repo1Dir);
    await git(["commit", "-m", "add new feature upstream"], repo1Dir);

    // 3. New session should automatically pull and branch from latest upstream commit
    const info2 = await manager.ensureSessionWorkspaces(testProject, "ses-2");
    const service2 = info2.repoPaths.get("service")!;
    expect(existsSync(path.join(service2, "new-feature.txt"))).toBe(true);
    expect(await Bun.file(path.join(service2, "new-feature.txt")).text()).toBe(
      "latest upstream code",
    );
  });

  test("multiple sessions created concurrently wait on single-flight pull without lock contention", async () => {
    // Commit changes upstream before concurrent creation
    await writeFile(path.join(repo1Dir, "concurrent.txt"), "concurrent test content");
    await git(["add", "concurrent.txt"], repo1Dir);
    await git(["commit", "-m", "commit for concurrent test"], repo1Dir);

    // Create 5 sessions concurrently
    const sessionIds = ["ses-c1", "ses-c2", "ses-c3", "ses-c4", "ses-c5"];
    const results = await Promise.all(
      sessionIds.map((id) => manager.ensureSessionWorkspaces(testProject, id)),
    );

    expect(results.length).toBe(5);
    for (let i = 0; i < 5; i++) {
      const p = results[i]!.repoPaths.get("service")!;
      expect(existsSync(p)).toBe(true);
      expect(existsSync(path.join(p, "concurrent.txt"))).toBe(true);
    }
  });
});
