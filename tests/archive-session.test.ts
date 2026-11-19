import { describe, expect, it } from "bun:test";
import { MemoryStore } from "../src/persistence/store.ts";
import { ProjectRuntime } from "../src/project/runtime.ts";
import { FakeRuntime } from "../src/runtime/runtime.ts";
import { WorkspaceManager } from "../src/workspace/workspace.ts";
import { ArtifactStore } from "../src/artifacts/store.ts";
import { MemoryEventHub } from "../src/events/hub.ts";
import type { ProjectConfig, EventRecord } from "../src/domain/types.ts";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

describe("Session Archive & Workspace Release (> 1 hour)", () => {
  it("archives session, releases workspace worktree, and marks session read-only", async () => {
    const root = `/tmp/archive-test-${Date.now()}`;
    const workspaceRoot = path.join(root, "workspaces");
    const baseRoot = path.join(root, "bases");
    const artifactsDir = path.join(root, "artifacts");

    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(baseRoot, { recursive: true });
    await mkdir(artifactsDir, { recursive: true });

    // Mock git repo
    const repoDir = path.join(baseRoot, "main");
    await mkdir(repoDir, { recursive: true });
    await Bun.$`git init -b main ${repoDir}`.quiet();
    await writeFile(path.join(repoDir, "README.md"), "# Hello");
    await Bun.$`git -C ${repoDir} add . && git -C ${repoDir} -c user.name=test -c user.email=test@test.com commit -m "init"`.quiet();

    const project: ProjectConfig = {
      id: "archive-proj",
      displayName: "Archive Project",
      description: "Project for testing session archiving",
      routing: {
        projectId: "archive-proj",
        displayName: "Archive Project",
        summary: "test",
        keywords: ["archive"],
      },
      repository: { url: repoDir, baseBranch: "main" },
      runtime: { type: "fake" },
      session: {
        idleTimeoutMs: 1800_000, // 30 mins
        archiveTimeoutMs: 3600_000, // 1 hour
      },
    };

    const store = new MemoryStore();
    const eventHub = new MemoryEventHub(store);
    const workspaces = new WorkspaceManager(workspaceRoot, baseRoot);
    const artifactStore = new ArtifactStore(artifactsDir, store);
    const fakeRuntime = new FakeRuntime();

    const runtime = new ProjectRuntime(
      project,
      store,
      fakeRuntime,
      workspaces,
      artifactStore,
      undefined,
      undefined,
      eventHub,
    );

    // Track emitted events
    const emittedEvents: EventRecord[] = [];
    eventHub.subscribeAll((e) => emittedEvents.push(e));

    // 1. Create session
    const session = await runtime.createSession();
    expect(session.status).toBe("active");

    // Verify workspace exists on disk
    const sessionWorkdir = path.join(workspaceRoot, "archive-proj", session.sessionId);
    expect(await Bun.file(path.join(sessionWorkdir, "README.md")).exists()).toBe(true);

    // 2. Perform a turn while active
    const turn1 = await runtime.turn(session.sessionId, "First question");
    expect(turn1.status).toBe("queued");

    // 3. Simulate time passing > 1 hour (e.g. 3601 seconds ago)
    const twoHoursAgo = new Date(Date.now() - 3601_000).toISOString();
    await runtime.waitForIdle(session.sessionId);
    runtime.sessionManager.get(session.sessionId)!.touch(twoHoursAgo);
    await runtime.sessionManager.save(session.sessionId);

    // 4. Run lifecycle check
    await runtime.checkLifecycles();

    // 5. Verify session is now archived
    const updated = await store.getSession(session.sessionId);
    expect(updated?.status).toBe("archived");

    // 6. Verify workspace directory has been removed/cleaned up
    expect(await Bun.file(path.join(sessionWorkdir, "README.md")).exists()).toBe(false);

    // 7. Verify session.archived event was emitted
    const archiveEvent = emittedEvents.find((e) => e.type === ("session.archived" as any));
    expect(archiveEvent).toBeDefined();

    // 8. Verify session is read-only (new turns must be rejected)
    expect(runtime.turn(session.sessionId, "Cannot submit to archived")).rejects.toThrow(
      "is archived and read-only",
    );

    // 9. Verify historical reads (events) still work
    const events = await runtime.events(session.sessionId);
    expect(events.length).toBeGreaterThan(0);

    // 10. Verify findSessionByExternal ignores archived session
    await runtime.bindExternal(session.sessionId, {
      channel: "feishu",
      conversationId: "oc_chat_999",
    });

    const found = await store.findSessionByExternal("feishu", "oc_chat_999");
    expect(found).toBeNull(); // Archived sessions must not be matched for inbound messages
  });
});
