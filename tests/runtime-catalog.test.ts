import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntimesRouter } from "../src/gateway/routes/system.ts";
import { Logger } from "../src/observability/logger.ts";
import { AGY_PROFILE, createACPAdapter } from "../src/runtime/acp/index.ts";
import {
  RuntimeModelCatalog,
  parseRuntimeModelsFile,
  type RuntimeInfo,
} from "../src/runtime/catalog.ts";
import { listClaudeModels } from "../src/runtime/claude/models.ts";
import { createCodexModelLister, parseCodexModelsCache } from "../src/runtime/codex/models.ts";
import type { RuntimeModelOption } from "../src/runtime/models.ts";
import { createPiModelLister, parsePiModelsJson } from "../src/runtime/pi/models.ts";
import { RuntimeRegistry } from "../src/runtime/registry.ts";
import { FakeRuntime } from "../src/runtime/runtime.ts";

describe("per-runtime Zod model parsers", () => {
  test("parseCodexModelsCache maps visible models, skips hidden/malformed entries, and tolerates extra/coercible fields", () => {
    const models = parseCodexModelsCache({
      models: [
        {
          slug: "gpt-5.6-terra",
          display_name: "GPT-5.6-Terra",
          visibility: "list",
          default_reasoning_level: "medium",
          supported_reasoning_levels: [
            { effort: "low", description: "fast" },
            { effort: "medium", description: "balanced" },
            { effort: "high", description: "deep" },
            { effort: "ultra", description: "max" },
            { invalid: true },
          ],
          context_window: "272000",
          extraUnknownField: "ignored",
        },
        {
          slug: "gpt-reserve",
          display_name: "Reserve",
          visibility: "hide",
          supported_reasoning_levels: [{ effort: "medium" }],
        },
        { badEntryWithoutSlug: 123 },
      ],
    });

    expect(models).toEqual([
      {
        id: "gpt-5.6-terra",
        displayName: "GPT-5.6-Terra",
        reasoningEfforts: ["low", "medium", "high", "ultra"],
        defaultReasoningEffort: "medium",
        contextWindow: 272000,
      },
    ]);
  });

  test("parsePiModelsJson extracts provider/id, thinkingLevelMap, reasoning boolean, and tolerates loose optional fields", () => {
    const models = parsePiModelsJson({
      providers: {
        deepseek: {
          models: [
            {
              id: "deepseek-v4-pro",
              name: "DeepSeek V4 Pro",
              reasoning: true,
              contextWindow: 1000000,
              thinkingLevelMap: {
                minimal: null,
                low: "low",
                medium: "high",
                high: "high",
                xhigh: "max",
                max: "max",
              },
            },
            {
              id: "deepseek-chat",
              name: "DeepSeek Chat",
              reasoning: false,
              contextWindow: "bad-number",
            },
          ],
        },
        custom: {
          models: [
            {
              id: "thinker",
              reasoning: true,
            },
          ],
        },
      },
    });

    expect(models).toEqual([
      {
        id: "deepseek/deepseek-v4-pro",
        displayName: "DeepSeek V4 Pro",
        reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
        contextWindow: 1000000,
      },
      {
        id: "deepseek/deepseek-chat",
        displayName: "DeepSeek Chat",
        reasoningEfforts: [],
      },
      {
        id: "custom/thinker",
        displayName: "thinker",
        reasoningEfforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      },
    ]);
  });

  test("parseRuntimeModelsFile accepts nested { runtimes } and flat objects with lenient optional fields", () => {
    const nested = parseRuntimeModelsFile({
      runtimes: {
        agy: [
          {
            id: "gemini-4-neon",
            displayName: "Gemini 4 Neon",
            reasoningEfforts: ["low", "medium", "high"],
            defaultReasoningEffort: "medium",
            contextWindow: 1048576,
          },
          { missingId: true },
        ],
      },
    });
    expect(nested.get("agy")).toHaveLength(1);
    expect(nested.get("agy")?.[0]?.id).toBe("gemini-4-neon");

    const flat = parseRuntimeModelsFile({
      claude: [{ id: "claude-opus-5-5", disabled: true }],
    });
    expect(flat.get("claude")).toEqual([{ id: "claude-opus-5-5", disabled: true }]);
  });
});

describe("RuntimeRegistry per-runtime discovery + RuntimeModelCatalog merge & /runtimes API", () => {
  let tmpDir: string;
  let codexHome: string;
  let piAgentDir: string;
  let modelsFile: string;
  let registry: RuntimeRegistry;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "ao-runtime-catalog-"));
    codexHome = path.join(tmpDir, "codex");
    piAgentDir = path.join(tmpDir, "pi");
    modelsFile = path.join(tmpDir, "runtime-models.json");
    const quiet = new Logger({ sink: () => {} });

    await Bun.write(
      path.join(codexHome, "models_cache.json"),
      JSON.stringify({
        models: [
          {
            slug: "gpt-6.2-sol",
            display_name: "GPT-6.2-Sol",
            visibility: "list",
            default_reasoning_level: "low",
            supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "ultra" }],
            context_window: 500000,
          },
          {
            slug: "gpt-5.6-terra",
            display_name: "GPT-5.6-Terra",
            visibility: "list",
            default_reasoning_level: "medium",
            supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }],
            context_window: 272000,
          },
        ],
      }),
    );
    await Bun.write(
      path.join(piAgentDir, "models.json"),
      JSON.stringify({
        providers: {
          deepseek: {
            models: [
              {
                id: "deepseek-v4-pro",
                name: "DeepSeek V4 Pro",
                reasoning: true,
                contextWindow: 1000000,
                thinkingLevelMap: { minimal: null, low: "low", high: "high" },
              },
            ],
          },
        },
      }),
    );
    await writeFile(
      modelsFile,
      JSON.stringify({
        runtimes: {
          codex: [
            { id: "gpt-6.2-sol", disabled: true },
            { id: "gpt-5.6-terra", defaultReasoningEffort: "high" },
          ],
          agy: [
            {
              id: "gemini-4-neon",
              displayName: "Gemini 4 Neon",
              reasoningEfforts: ["low", "medium", "high"],
              defaultReasoningEffort: "medium",
              contextWindow: 1048576,
            },
          ],
        },
      }),
    );

    registry = new RuntimeRegistry(quiet);
    registry.register("fake", () => new FakeRuntime(), {
      internal: true,
      defaultReasoningEfforts: [],
    });
    registry.register("codex", () => new FakeRuntime(), {
      defaultReasoningEfforts: ["low", "medium", "high"],
      listModels: createCodexModelLister({ codexHome, logger: quiet }),
    });
    registry.register("pi", () => new FakeRuntime(), {
      defaultReasoningEfforts: ["off", "low", "high"],
      listModels: createPiModelLister({ piAgentDir, logger: quiet }),
    });
    registry.register("claude", () => new FakeRuntime(), {
      defaultReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      listModels: listClaudeModels,
    });
    registry.register(createACPAdapter(AGY_PROFILE));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("GET /runtimes delegates model discovery to each runtime and merges runtime-models.json overrides", async () => {
    const catalog = new RuntimeModelCatalog({
      modelsFile,
      logger: new Logger({ sink: () => {} }),
    });
    const router = createRuntimesRouter(registry, catalog);

    const allRes = await router.request("/runtimes");
    expect(allRes.status).toBe(200);
    const allData = (await allRes.json()) as { runtimes: RuntimeInfo[] };
    expect(allData.runtimes.some((r) => r.type === "fake" && r.internal === true)).toBe(true);

    const publicRes = await router.request("/runtimes?includeInternal=false");
    expect(publicRes.status).toBe(200);
    const publicData = (await publicRes.json()) as { runtimes: RuntimeInfo[] };
    expect(publicData.runtimes.some((r) => r.type === "fake")).toBe(false);

    const codex = publicData.runtimes.find((r) => r.type === "codex");
    expect(codex?.models).toEqual([
      {
        id: "gpt-5.6-terra",
        displayName: "GPT-5.6-Terra",
        reasoningEfforts: ["low", "medium", "high"],
        defaultReasoningEffort: "high",
        contextWindow: 272000,
      },
    ]);

    const pi = publicData.runtimes.find((r) => r.type === "pi");
    expect(pi?.models).toEqual([
      {
        id: "deepseek/deepseek-v4-pro",
        displayName: "DeepSeek V4 Pro",
        reasoningEfforts: ["low", "high"],
        contextWindow: 1000000,
      },
    ]);

    const claude = publicData.runtimes.find((r) => r.type === "claude");
    expect(claude?.models.some((m) => m.id === "claude-opus-5-5")).toBe(true);
    expect(claude?.models.some((m) => m.id === "claude-sonnet-5-5")).toBe(true);
    expect(claude?.models.some((m) => m.id === "claude-haiku-5-5")).toBe(true);

    const agy = publicData.runtimes.find((r) => r.type === "agy");
    expect(agy?.models).toEqual([
      {
        id: "gemini-4-neon",
        displayName: "Gemini 4 Neon",
        reasoningEfforts: ["low", "medium", "high"],
        defaultReasoningEffort: "medium",
        contextWindow: 1048576,
      },
    ]);
  });

  test("custom registered runtimes expose their own models without touching catalog code", async () => {
    registry.register("custom-rt", () => new FakeRuntime(), {
      defaultReasoningEfforts: ["low", "high"],
      listModels: () => [
        { id: "my-model", displayName: "My Model", reasoningEfforts: ["low", "high"] },
      ],
    });
    const catalog = new RuntimeModelCatalog({ modelsFile });
    const models = await catalog.listModels(registry, "custom-rt");
    expect(models).toEqual([
      { id: "my-model", displayName: "My Model", reasoningEfforts: ["low", "high"] },
    ]);
  });

  test("GET /runtimes/:runtimeType/models hot-reloads JSON changes without restart", async () => {
    const catalog = new RuntimeModelCatalog({ modelsFile });
    const router = createRuntimesRouter(registry, catalog);

    const missing = await router.request("/runtimes/nonexistent/models");
    expect(missing.status).toBe(404);

    const res1 = await router.request("/runtimes/agy/models");
    expect(res1.status).toBe(200);
    const data1 = (await res1.json()) as { runtime: string; models: RuntimeModelOption[] };
    expect(data1.models.map((m) => m.id)).toEqual(["gemini-4-neon"]);

    await writeFile(
      modelsFile,
      JSON.stringify({
        runtimes: {
          agy: [
            { id: "gemini-4-neon", reasoningEfforts: ["low", "high"] },
            { id: "gemini-4-pro", displayName: "Gemini 4 Pro" },
          ],
        },
      }),
    );

    const res2 = await router.request("/runtimes/agy/models");
    const data2 = (await res2.json()) as { models: RuntimeModelOption[] };
    expect(data2.models).toEqual([
      {
        id: "gemini-4-neon",
        displayName: "gemini-4-neon",
        reasoningEfforts: ["low", "high"],
      },
      {
        id: "gemini-4-pro",
        displayName: "Gemini 4 Pro",
        reasoningEfforts: ["low", "medium", "high"],
      },
    ]);
  });
});
