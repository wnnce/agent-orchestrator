import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { AppConfig } from "../src/config/config.ts";
import { ErrorCode, NotFoundError } from "../src/domain/errors.ts";
import type { ArtifactRecord, ProjectConfig } from "../src/domain/types.ts";
import { Logger } from "../src/observability/logger.ts";
import { fetchPage } from "../src/persistence/pagination.ts";
import { MemoryStore } from "../src/persistence/store.ts";
import { ProjectManager } from "../src/project/manager.ts";

const project: ProjectConfig = {
  id: "lookup-proj",
  displayName: "Lookup",
  description: "",
  routing: { projectId: "lookup-proj", displayName: "Lookup", summary: "", keywords: [] },
  runtime: { type: "fake" },
  repository: { url: "", baseBranch: "main" },
};

const config = {
  dataDir: "/tmp/project-lookup-test-data",
  artifactDir: "/tmp/project-lookup-test-artifacts",
} as AppConfig;

function artifact(id: string, sessionId: string, kind: string): ArtifactRecord {
  return {
    id,
    projectId: project.id,
    originKind: "session",
    originId: sessionId,
    kind,
    path: `/tmp/${id}`,
    contentType: "text/plain",
    sizeBytes: 1,
    createdAt: new Date().toISOString(),
  };
}

describe("ProjectManager lookups", () => {
  const store = new MemoryStore();
  const manager = new ProjectManager([project], store, config, new Logger({ level: "error" }));
  beforeAll(() => manager.start());
  afterAll(() => manager.stop());

  it("finds the runtime of the project that owns a session", async () => {
    const session = await manager.get(project.id).createSession();
    const runtime = await manager.runtimeForSession(session.sessionId);
    expect(runtime.project.id).toBe(project.id);
  });

  it("reports unknown sessions, pipeline runs and node runs as not found", async () => {
    const missingSession = manager.runtimeForSession("ses_missing");
    await expect(missingSession).rejects.toBeInstanceOf(NotFoundError);
    await expect(missingSession).rejects.toMatchObject({ code: ErrorCode.SESSION_NOT_FOUND });
    await expect(manager.runtimeForPipelineRun("run_missing")).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(manager.runtimeForNodeRun("node_missing")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("leaves internal artifacts out of a session's artifacts unless asked", async () => {
    const runtime = manager.get(project.id);
    const session = await runtime.createSession();
    await store.addArtifact(artifact("art_report", session.sessionId, "report"));
    await store.addArtifact(artifact("art_message", session.sessionId, "agent-message"));

    const visible = await runtime.listArtifacts(session.sessionId);
    expect(visible.map((item) => item.id)).toEqual(["art_report"]);
    const all = await runtime.listArtifacts(session.sessionId, { includeInternal: true });
    expect(all.map((item) => item.id).sort()).toEqual(["art_message", "art_report"]);
    // Internal artifacts can still be fetched by id.
    expect((await runtime.artifact(session.sessionId, "art_message")).kind).toBe("agent-message");
  });
});

describe("fetchPage", () => {
  const rows = [5, 4, 3, 2, 1];
  const load = async (limit: number) => rows.slice(0, limit);

  it("returns a full page and reports more rows", async () => {
    expect(await fetchPage(2, load)).toEqual({ items: [5, 4], hasMore: true });
  });

  it("reports no more rows when the page is the last one", async () => {
    expect(await fetchPage(5, load)).toEqual({ items: rows, hasMore: false });
    expect(await fetchPage(10, load)).toEqual({ items: rows, hasMore: false });
  });
});
