import { test, expect } from "bun:test";
import { mkdir, mkdtemp, writeFile, chmod, rm, realpath } from "node:fs/promises";
import path from "node:path";
import { CodexRuntime } from "../src/runtime/codex.ts";
import type { RuntimeEvent } from "../src/runtime/runtime.ts";
import type { ProjectConfig } from "../src/domain/types.ts";
import { Logger } from "../src/observability/logger.ts";

const project: ProjectConfig = {
  id: "codex-test",
  displayName: "Codex Test",
  description: "test",
  routing: {
    projectId: "codex-test",
    displayName: "Codex Test",
    summary: "test",
    repositories: [],
    keywords: [],
    routingHints: [],
  },
  runtime: { type: "codex", codexHome: "/tmp/codex-test-home" },
  repositories: [],
  prompts: {},
};

test("Codex runtime speaks app-server JSONL", async () => {
  const root = await mkdtemp("/tmp/codex-runtime-");
  const script = path.join(root, "fake-codex");
  await writeFile(
    script,
    `#!/usr/bin/env bun\nimport { createInterface } from "node:readline";\nconst rl = createInterface({ input: process.stdin });\nrl.on("line", line => { const m = JSON.parse(line); if (m.method === "initialize") console.log(JSON.stringify({ id: m.id, result: {} })); else if (m.method === "thread/start") console.log(JSON.stringify({ id: m.id, result: { thread: { id: "thread-test" } } })); else if (m.method === "thread/resume") console.log(JSON.stringify({ id: m.id, result: { thread: { id: "thread-test" } } })); else if (m.method === "turn/start") { console.log(JSON.stringify({ id: m.id, result: { turn: { id: "runtime-turn" } } })); console.log(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: "thread-test", turnId: "runtime-turn", itemId: "msg-1", delta: "hello" } })); console.log(JSON.stringify({ method: "turn/completed", params: { threadId: "thread-test", turn: { id: "runtime-turn", status: "completed", items: [], error: null, durationMs: null } } })); } });\n`,
    { mode: 0o755 },
  );
  await chmod(script, 0o755);
  const runtime = new CodexRuntime(script, undefined, { apiKey: "test-service-key" });
  const events: string[] = [];
  const context = {
    project,
    workspacePath: root,
    onEvent: (event: RuntimeEvent) => {
      events.push(event.type);
    },
  };
  const session = await runtime.startSession(context);
  expect(session.id).toBe("thread-test");
  const turn = await runtime.startTurn(context, session.id, "gateway-turn", "hello");
  expect(turn.id).toBe("runtime-turn");
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(events).toContain("agent.message.delta");
  expect(events).toContain("turn.completed");
  await runtime.stop();
  await rm(root, { recursive: true, force: true });
});

test("Codex replaces imported state and strips inherited Codex settings", async () => {
  const root = await mkdtemp("/tmp/codex-isolation-");
  const codexHome = path.join(root, "managed-state");
  const script = path.join(root, "fake-codex");
  const previous = {
    CODEX_HOME: process.env.CODEX_HOME,
    CODEX_PROFILE: process.env.CODEX_PROFILE,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  };
  const runtime = new CodexRuntime(script, new Logger({ sink: () => {} }), {
    apiKey: "service-test-key",
    model_provider: "custom-proxy",
    model_providers: {
      "custom-proxy": {
        name: "custom-proxy",
        base_url: "https://provider.example.com/v1",
        wire_api: "responses",
        requires_openai_auth: true,
      },
    },
  });
  try {
    await mkdir(codexHome);
    await writeFile(
      path.join(codexHome, "auth.json"),
      JSON.stringify({ tokens: { refresh_token: "stale-login" } }),
    );
    await writeFile(
      path.join(codexHome, "config.toml"),
      '[mcp_servers.personal]\nurl = "https://personal.example.com/mcp"\n',
    );
    await writeFile(
      script,
      `#!/usr/bin/env bun
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
writeFileSync("spawn.json", JSON.stringify({
  cwd: process.cwd(),
  codexHome: process.env.CODEX_HOME,
  inherited: Object.keys(process.env).filter(key =>
    (key.startsWith("CODEX_") || key.startsWith("OPENAI_")) && key !== "CODEX_HOME"
  ),
}));
createInterface({ input: process.stdin }).on("line", line => {
  const m = JSON.parse(line);
  if (m.method === "initialize") console.log(JSON.stringify({ id: m.id, result: {} }));
  else if (m.method === "thread/start") console.log(JSON.stringify({ id: m.id, result: { thread: { id: "isolated-thread" } } }));
});
`,
      { mode: 0o755 },
    );
    process.env.CODEX_HOME = path.join(root, "external-state");
    process.env.CODEX_PROFILE = "personal-profile";
    process.env.OPENAI_API_KEY = "personal-test-key";
    process.env.OPENAI_BASE_URL = "https://personal.example.com/v1";

    await runtime.startSession({
      project: {
        ...project,
        runtime: {
          type: "codex",
          codexHome,
          mcpServers: [{ name: "project-tools", url: "https://tools.example.com/mcp" }],
        },
      },
      workspacePath: root,
      onEvent: () => {},
    });
    expect(await Bun.file(path.join(codexHome, "auth.json")).json()).toEqual({
      auth_mode: "apikey",
      OPENAI_API_KEY: "service-test-key",
    });
    const generated = Bun.TOML.parse(
      await Bun.file(path.join(codexHome, "config.toml")).text(),
    ) as any;
    expect(generated.cli_auth_credentials_store).toBe("file");
    expect(generated.model_providers["custom-proxy"].base_url).toBe(
      "https://provider.example.com/v1",
    );
    expect(generated.mcp_servers["project-tools"].url).toBe("https://tools.example.com/mcp");
    expect(generated.mcp_servers.personal).toBeUndefined();
    const spawn = await Bun.file(path.join(codexHome, "spawn.json")).json();
    expect(await realpath(spawn.cwd)).toBe(await realpath(codexHome));
    expect(spawn.codexHome).toBe(codexHome);
    expect(spawn.inherited).toEqual([]);
  } finally {
    await runtime.stop();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex requires the service API key instead of reusing existing login state", async () => {
  const root = await mkdtemp("/tmp/codex-missing-key-");
  const runtime = new CodexRuntime("/must-not-spawn-codex", new Logger({ sink: () => {} }));
  try {
    await writeFile(path.join(root, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "stale-key" }));
    await expect(
      runtime.startSession({
        project: { ...project, runtime: { type: "codex", codexHome: root } },
        workspacePath: root,
        onEvent: () => {},
      }),
    ).rejects.toThrow("codex.apiKey");
  } finally {
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex runtime maps arbitrary configuration and custom model providers to config.toml", async () => {
  const root = await mkdtemp("/tmp/codex-arbitrary-config-");
  const codexHome = path.join(root, "managed-codex");
  const script = path.join(root, "fake-codex");
  await writeFile(
    script,
    `#!/usr/bin/env bun
import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", line => {
  const m = JSON.parse(line);
  if (m.method === "initialize") console.log(JSON.stringify({ id: m.id, result: {} }));
  else if (m.method === "thread/start") console.log(JSON.stringify({ id: m.id, result: { thread: { id: "thread-custom" } } }));
});
`,
    { mode: 0o755 },
  );

  const runtime = new CodexRuntime(
    script,
    new Logger({ sink: () => {} }),
    {
      apiKey: "custom-api-key",
      model: "o3-mini",
      model_provider: "custom_gateway",
      model_providers: {
        custom_gateway: {
          name: "custom_gateway",
          base_url: "https://custom-gateway.internal/v1",
          wire_api: "chat",
          requires_openai_auth: false,
        },
      },
      custom_section: {
        telemetry: false,
        retries: 3,
      },
    },
  );

  try {
    await runtime.startSession({
      project: {
        ...project,
        runtime: {
          type: "codex",
          codexHome,
          config: {
            temperature: 0.2,
          },
        },
      },
      workspacePath: root,
      onEvent: () => {},
    });

    const generatedToml = Bun.TOML.parse(
      await Bun.file(path.join(codexHome, "config.toml")).text(),
    ) as any;

    expect(generatedToml.model).toBe("o3-mini");
    expect(generatedToml.model_provider).toBe("custom_gateway");
    expect(generatedToml.model_providers.custom_gateway).toEqual({
      name: "custom_gateway",
      base_url: "https://custom-gateway.internal/v1",
      wire_api: "chat",
      requires_openai_auth: false,
    });
    expect(generatedToml.custom_section).toEqual({
      telemetry: false,
      retries: 3,
    });
    expect(generatedToml.temperature).toBe(0.2);
    expect(generatedToml.cli_auth_credentials_store).toBe("file");
  } finally {
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex runtime merges baseConfigPath template file and project runtime overrides", async () => {
  const root = await mkdtemp("/tmp/codex-base-template-");
  const codexHome = path.join(root, "managed-codex");
  const baseTomlFile = path.join(root, "base.toml");
  await writeFile(
    baseTomlFile,
    `
[model_providers.shared_proxy]
name = "shared_proxy"
base_url = "https://shared.internal/v1"
wire_api = "responses"

[company_defaults]
region = "us-east-1"
`,
  );

  const script = path.join(root, "fake-codex");
  await writeFile(
    script,
    `#!/usr/bin/env bun
import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", line => {
  const m = JSON.parse(line);
  if (m.method === "initialize") console.log(JSON.stringify({ id: m.id, result: {} }));
  else if (m.method === "thread/start") console.log(JSON.stringify({ id: m.id, result: { thread: { id: "thread-base" } } }));
});
`,
    { mode: 0o755 },
  );

  const runtime = new CodexRuntime(
    script,
    new Logger({ sink: () => {} }),
    {
      apiKey: "service-key",
      baseConfigPath: baseTomlFile,
      model_provider: "shared_proxy",
    },
  );

  try {
    await runtime.startSession({
      project: {
        ...project,
        runtime: {
          type: "codex",
          codexHome,
          model: "gpt-4o",
          reasoningEffort: "high",
          config: {
            company_defaults: {
              cluster: "prod-1",
            },
          },
        },
      },
      workspacePath: root,
      onEvent: () => {},
    });

    const generatedToml = Bun.TOML.parse(
      await Bun.file(path.join(codexHome, "config.toml")).text(),
    ) as any;

    expect(generatedToml.model).toBe("gpt-4o");
    expect(generatedToml.model_reasoning_effort).toBe("high");
    expect(generatedToml.model_provider).toBe("shared_proxy");
    expect(generatedToml.model_providers.shared_proxy.base_url).toBe(
      "https://shared.internal/v1",
    );
    expect(generatedToml.company_defaults).toEqual({
      region: "us-east-1",
      cluster: "prod-1",
    });
  } finally {
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  }
});
