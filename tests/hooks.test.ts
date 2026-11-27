import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadProjectHooks } from "../src/hooks/loader.ts";
import { verifyHmacSha256 } from "../src/hooks/sdk.ts";
import { Logger } from "../src/observability/logger.ts";

const SDK = path.resolve("src/hooks/sdk.ts");

function hookFile(spec: string): string {
  return `import { defineHook } from ${JSON.stringify(SDK)};
export default defineHook(${spec});
`;
}

describe("loadProjectHooks", () => {
  let projectDir: string;
  const lines: string[] = [];
  const logger = new Logger({ sink: (line) => lines.push(line) });

  beforeAll(async () => {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "hooks-loader-"));
    const hooksDir = path.join(projectDir, "hooks");
    await mkdir(hooksDir);
    const files: Record<string, string> = {
      "github.ts": hookFile(`{ name: "GitHub", handle: () => {} }`),
      "grafana.ts": hookFile(`{ id: "alerts", name: "Grafana", handle: () => {} }`),
      // Declares the same id as grafana.ts but sorts later, so it is skipped.
      "zz-alerts.ts": hookFile(`{ id: "alerts", name: "Other alerts", handle: () => {} }`),
      "nameless.ts": hookFile(`{ handle: () => {} }`),
      "plain.ts": `export default { name: "Plain", handle: () => {} };\n`,
      "broken.ts": `throw new Error("boom");\n`,
      "bad id.ts": hookFile(`{ name: "Bad id", handle: () => {} }`),
      "_shared.ts": `export const helper = 1;\n`,
      "github.test.ts": `export default 1;\n`,
      "types.d.ts": `export {};\n`,
    };
    for (const [name, content] of Object.entries(files)) {
      await writeFile(path.join(hooksDir, name), content);
    }
  });
  afterAll(() => rm(projectDir, { recursive: true, force: true }));

  it("loads hooks under their declared id or their file name", async () => {
    const hooks = await loadProjectHooks(projectDir, "demo", logger);
    expect([...hooks.keys()].sort()).toEqual(["alerts", "github"]);
    expect(hooks.get("github")?.name).toBe("GitHub");
    expect(hooks.get("alerts")?.name).toBe("Grafana");
  });

  it("logs files it skips and why", async () => {
    lines.length = 0;
    await loadProjectHooks(projectDir, "demo", logger);
    const entries = lines.map((line) => JSON.parse(line) as Record<string, string>);
    const failed = entries
      .filter((entry) => entry.message === "failed to load project hook")
      .map((entry) => path.basename(entry.filePath ?? ""))
      .sort();
    expect(failed).toEqual(["bad id.ts", "broken.ts", "nameless.ts", "plain.ts"]);
    const duplicate = entries.find((entry) => entry.message === "duplicate project hook skipped");
    expect(path.basename(duplicate?.skippedFile ?? "")).toBe("zz-alerts.ts");
  });

  it("returns no hooks for a project without a hooks directory", async () => {
    expect((await loadProjectHooks(os.tmpdir(), "none", logger)).size).toBe(0);
  });
});

describe("verifyHmacSha256", () => {
  const secret = "s3cret";
  const body = '{"action":"opened"}';
  const digest = createHmac("sha256", secret).update(body).digest("hex");

  it("accepts a matching signature, with or without a prefix", () => {
    expect(verifyHmacSha256(body, digest, secret)).toBe(true);
    expect(verifyHmacSha256(body, `sha256=${digest}`, secret, "sha256=")).toBe(true);
    expect(verifyHmacSha256(new TextEncoder().encode(body), digest, secret)).toBe(true);
  });

  it("rejects wrong, missing or malformed signatures", () => {
    expect(verifyHmacSha256(body, digest, "other")).toBe(false);
    expect(verifyHmacSha256(`${body} `, digest, secret)).toBe(false);
    expect(verifyHmacSha256(body, null, secret)).toBe(false);
    expect(verifyHmacSha256(body, digest, secret, "sha256=")).toBe(false);
    expect(verifyHmacSha256(body, "not-hex", secret)).toBe(false);
    expect(verifyHmacSha256(body, digest, "")).toBe(false);
  });
});
