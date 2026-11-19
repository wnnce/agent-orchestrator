import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configPathFromArgs, loadConfig } from "../src/config/config.ts";

describe("service YAML configuration", () => {
  let root: string;
  let file: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "orchestrator-config-"));
    file = path.join(root, "config.yaml");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("loads service settings and resolves paths from the YAML directory", async () => {
    await writeFile(
      file,
      `
host: 127.0.0.1
port: 8088
logLevel: debug
dataDir: runtime
artifactDir: output
projectConfigPath: project-catalog.yaml
databaseUrl: postgres://localhost/orchestrator
allowUnauthenticated: false
apiToken: test-api-token
routerModel: test-router
routerApiKey: test-router-key
routerBaseUrl: https://router.example.com/v1
feishu:
  enabled: true
  verificationToken: test-verification-token
`,
    );
    const config = await loadConfig(file);
    expect(config).toMatchObject({
      host: "127.0.0.1",
      port: 8088,
      logLevel: "debug",
      dataDir: path.join(root, "runtime"),
      artifactDir: path.join(root, "output"),
      projectConfigPath: path.join(root, "project-catalog.yaml"),
      databaseUrl: "postgres://localhost/orchestrator",
      allowUnauthenticated: false,
      apiToken: "test-api-token",
      routerModel: "test-router",
      routerApiKey: "test-router-key",
      routerBaseUrl: "https://router.example.com/v1",
      feishu: { enabled: true, verificationToken: "test-verification-token" },
    });
  });

  test("defaultRuntime defaults to codex and can be set", async () => {
    await writeFile(file, "server:\n  port: 7070\n");
    expect((await loadConfig(file)).defaultRuntime).toBe("codex");
    await writeFile(file, "defaultRuntime: claude\n");
    expect((await loadConfig(file)).defaultRuntime).toBe("claude");
  });

  test("loads global notifications from service YAML", async () => {
    await writeFile(
      file,
      `notifications:
  - name: feishu-ops
    type: feishu
    url: https://open.feishu.cn/hook/1
    enabled: true
  - name: wecom-ops
    type: wecom
    url: https://qyapi.weixin.qq.com/hook/2
    enabled: true
`,
    );
    const config = await loadConfig(file);
    expect(config.notifications).toEqual([
      { name: "feishu-ops", type: "feishu", url: "https://open.feishu.cn/hook/1", enabled: true },
      { name: "wecom-ops", type: "wecom", url: "https://qyapi.weixin.qq.com/hook/2", enabled: true },
    ]);
  });

  test("applies defaults and derives the artifact directory", async () => {
    await writeFile(file, 'dataDir: runtime\ndatabaseUrl: ""\n');
    const config = await loadConfig(file);
    expect(config.port).toBe(7070);
    expect(config.artifactDir).toBe(path.join(root, "runtime/artifacts"));
    expect(config.projectConfigPath).toBe(path.join(root, "projects"));
    expect(config.databaseUrl).toBeUndefined();
    expect(config.feishu.enabled).toBe(false);
  });

  test("ignores service environment variables and a neighboring .env file", async () => {
    const overrides = {
      HOST: "env-host",
      PORT: "9999",
      DATA_DIR: "/env-data",
      DATABASE_URL: "postgres://env/database",
      AUTH_TOKEN: "env-api-token",
      LOG_LEVEL: "error",
      FEISHU_ENABLED: "true",
      FEISHU_VERIFICATION_TOKEN: "env-verification-token",
      OPENAI_API_KEY: "env-codex-key",
      CODEX_PROXY_URL: "https://env.example.com/v1",
    };
    const previous = Object.fromEntries(
      Object.keys(overrides).map((key) => [key, process.env[key]]),
    );
    try {
      Object.assign(process.env, overrides);
      await writeFile(path.join(root, ".env"), "PORT=9998\nAUTH_TOKEN=dotenv-token\n");
      await writeFile(file, "{}\n");
      const config = await loadConfig(file);
      expect(config.host).toBe("0.0.0.0");
      expect(config.port).toBe(7070);
      expect(config.dataDir).toBe(path.join(root, ".data"));
      expect(config.apiToken).toBeUndefined();
      expect(config.databaseUrl).toBeUndefined();
      expect(config.logLevel).toBe("info");
      expect(config.feishu.enabled).toBe(false);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test.each([
    ['port: "7070"', "port"],
    ["port: 70000", "port"],
    ['allowUnauthenticated: "false"', "allowUnauthenticated"],
    ["logLevel: verbose", "logLevel"],
    ["feishu:\n  enabled: true", "feishu.verificationToken"],
    ["unknownOption: true", "Unrecognized key"],
    ["codexBinary: /opt/external/codex", "Unrecognized key"],
    // Runtimes read their own configuration (~/.codex, ~/.claude, ~/.pi) since design 05.
    ["runtimes:\n  codex:\n    apiKey: k", "Unrecognized key"],
    ["codex:\n  apiKey: k", "Unrecognized key"],
  ])("rejects invalid configuration: %s", async (content, field) => {
    await writeFile(file, content);
    await expect(loadConfig(file)).rejects.toThrow(field);
  });

  test("rejects malformed YAML without printing credential contents", async () => {
    await writeFile(file, "apiToken: [sensitive-test-value\n");
    try {
      await loadConfig(file);
      throw new Error("Expected invalid YAML to be rejected");
    } catch (error) {
      expect(String(error)).toContain("Invalid service YAML");
      expect(String(error)).not.toContain("sensitive-test-value");
    }
  });

  test("requires the selected file instead of falling back to environment settings", async () => {
    await expect(loadConfig(file)).rejects.toThrow("Service configuration not found");
  });

  test("loads modern hierarchical configuration with nested domain sections", async () => {
    await writeFile(
      file,
      `
server:
  host: 127.0.0.1
  port: 8090

logging:
  level: warn

storage:
  dataDir: var/data
  projectsDir: var/projects
  artifactDir: var/artifacts
  databaseUrl: postgres://db.internal:5432/app

auth:
  token: secret-bearer-token
  allowUnauthenticated: false

router:
  model: gpt-4o-mini
  apiKey: router-api-key
  baseUrl: https://custom-router.ai/v1

channels:
  feishu:
    enabled: true
    verificationToken: feishu-token
`,
    );

    const config = await loadConfig(file);

    // Verify hierarchical properties
    expect(config.server).toEqual({ host: "127.0.0.1", port: 8090 });
    expect(config.logging).toEqual({ level: "warn" });
    expect(config.storage).toEqual({
      dataDir: path.join(root, "var/data"),
      projectsDir: path.join(root, "var/projects"),
      artifactDir: path.join(root, "var/artifacts"),
      databaseUrl: "postgres://db.internal:5432/app",
    });
    expect(config.auth).toEqual({
      token: "secret-bearer-token",
      allowUnauthenticated: false,
    });
    expect(config.router).toEqual({
      model: "gpt-4o-mini",
      apiKey: "router-api-key",
      baseUrl: "https://custom-router.ai/v1",
    });
    expect(config.channels!.feishu).toEqual({
      enabled: true,
      verificationToken: "feishu-token",
    });

    // Verify backward-compatible accessors
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(8090);
    expect(config.logLevel).toBe("warn");
    expect(config.dataDir).toBe(path.join(root, "var/data"));
    expect(config.projectConfigPath).toBe(path.join(root, "var/projects"));
    expect(config.artifactDir).toBe(path.join(root, "var/artifacts"));
    expect(config.databaseUrl).toBe("postgres://db.internal:5432/app");
    expect(config.apiToken).toBe("secret-bearer-token");
    expect(config.allowUnauthenticated).toBe(false);
    expect(config.routerModel).toBe("gpt-4o-mini");
    expect(config.routerApiKey).toBe("router-api-key");
    expect(config.routerBaseUrl).toBe("https://custom-router.ai/v1");
    expect(config.feishu.verificationToken).toBe("feishu-token");
  });

  test("loads the checked-in example", async () => {
    const config = await loadConfig(path.resolve(import.meta.dir, "../config.example.yaml"));
    expect(config.port).toBe(7070);
    expect(config.feishu.enabled).toBe(false);
  });
});

describe("service config path arguments", () => {
  test.each([
    [[], "config.yaml"],
    [["--config", "/tmp/service.yaml"], "/tmp/service.yaml"],
    [["-c", "custom.yaml"], "custom.yaml"],
    [["--config=custom.yaml"], "custom.yaml"],
  ])("selects the YAML path for %j", (args, expected) => {
    expect(configPathFromArgs(args)).toBe(expected);
  });
  test.each(["--config", "--config=", "--unknown"])("rejects invalid arguments %j", (arg) => {
    expect(() => configPathFromArgs([arg])).toThrow("Usage:");
  });
  test("rejects extra arguments", () => {
    expect(() => configPathFromArgs(["--config", "a", "b"])).toThrow("Usage:");
  });
});
