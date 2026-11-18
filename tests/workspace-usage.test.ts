import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ArtifactStore } from "../src/artifacts/store.ts";
import type { ProjectConfig } from "../src/domain/types.ts";
import { Logger } from "../src/observability/logger.ts";
import { MemoryStore } from "../src/persistence/store.ts";
import { ProjectRuntime } from "../src/project/runtime.ts";
import { FakeRuntime } from "../src/runtime/runtime.ts";
import { WorkspaceManager, type SessionWorkspaceInfo } from "../src/workspace/workspace.ts";

/** Counts the calls that sync base repositories and create worktrees. */
class CountingWorkspaces extends WorkspaceManager {
  prepared = 0;
  override async ensureSessionWorkspaces(
    project: ProjectConfig,
    sessionId: string,
  ): Promise<SessionWorkspaceInfo> {
    this.prepared++;
    return super.ensureSessionWorkspaces(project, sessionId);
  }
}

describe("session workspace usage", () => {
  let root: string;
  let store: MemoryStore;
  let workspaces: CountingWorkspaces;
  let runtime: ProjectRuntime;

  beforeEach(async () => {
    root = await mkdtemp("/tmp/workspace-usage-");
    const remote = path.join(root, "remote");
    await mkdir(remote, { recursive: true });
    await Bun.$`git init -q -b main ${remote}`.quiet();
    await writeFile(path.join(remote, "README.md"), "# remote");
    await Bun.$`git -C ${remote} add . && git -C ${remote} -c user.name=t -c user.email=t@t commit -qm init`.quiet();

    const project: ProjectConfig = {
      id: "usage",
      displayName: "Usage",
      description: "test",
      routing: { projectId: "usage" },
      repositories: [{ id: "main", url: remote, baseBranch: "main", isPrimary: true }],
      runtime: { type: "fake" },
    };
    store = new MemoryStore();
    workspaces = new CountingWorkspaces(
      path.join(root, "workspaces"),
      path.join(root, "bases"),
      undefined,
      new Logger({ sink: () => {} }),
    );
    runtime = new ProjectRuntime(
      project,
      store,
      new FakeRuntime(),
      workspaces,
      new ArtifactStore(path.join(root, "artifacts"), store),
      undefined,
      new Logger({ sink: () => {} }),
    );
  });

  afterEach(async () => {
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  });

  test("only session creation prepares the workspace", async () => {
    const session = await runtime.createSession();
    expect(workspaces.prepared).toBe(1);
    expect(session.workspacePath).toBe(
      path.join(root, "workspaces", "usage", session.sessionId, "main"),
    );

    await runtime.turn(session.sessionId, "first");
    await runtime.turn(session.sessionId, "second");
    await runtime.waitForIdle(session.sessionId);
    await runtime.compact(session.sessionId);
    await runtime.interrupt(session.sessionId);
    expect(workspaces.prepared).toBe(1);
  });

  test("a missing worktree is recreated before the next turn", async () => {
    const session = await runtime.createSession();
    await workspaces.removeSession(runtime.project, session.sessionId);
    expect(existsSync(session.workspacePath!)).toBe(false);

    await runtime.turn(session.sessionId, "after cleanup");
    await runtime.waitForIdle(session.sessionId);
    expect(workspaces.prepared).toBe(2);
    expect(existsSync(path.join(session.workspacePath!, ".git"))).toBe(true);
  });

  test("closing a session whose worktree is gone does not recreate it", async () => {
    const session = await runtime.createSession();
    await workspaces.removeSession(runtime.project, session.sessionId);
    await runtime.cleanupSession(session.sessionId);
    expect(workspaces.prepared).toBe(1);
    expect(existsSync(session.workspacePath!)).toBe(false);
  });
});
