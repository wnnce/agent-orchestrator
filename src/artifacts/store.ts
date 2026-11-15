import { mkdir, stat, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ArtifactRecord } from "../domain/types.ts";
import type { Store } from "../persistence/store.ts";
import { assertSafeId } from "../domain/ids.ts";

export class ArtifactStore {
  constructor(
    private readonly root: string,
    private readonly store: Store,
  ) {}

  async write(
    projectId: string,
    sessionId: string,
    turnId: string | undefined,
    kind: string,
    content: string | Uint8Array,
    contentType: string,
  ): Promise<ArtifactRecord> {
    assertSafeId(projectId, "projectId");
    assertSafeId(sessionId, "sessionId");
    const id = `art_${randomUUID()}`;
    const file = path.join(this.root, projectId, sessionId, `${id}.bin`);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o750 });
    await writeFile(file, content, { mode: 0o640 });
    const info = await stat(file);
    const artifact: ArtifactRecord = {
      id,
      projectId,
      sessionId,
      ...(turnId ? { turnId } : {}),
      kind,
      path: file,
      contentType,
      sizeBytes: info.size,
      createdAt: new Date().toISOString(),
    };
    await this.store.addArtifact(artifact);
    return artifact;
  }

  async read(artifact: ArtifactRecord): Promise<Uint8Array> {
    return readFile(artifact.path);
  }
}
