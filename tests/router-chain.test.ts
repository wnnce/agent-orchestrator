import { describe, expect, test } from "bun:test";
import {
  RoutingPipeline,
  SessionStickyHandler,
  KeywordMatchHandler,
  JevDecisionHandler,
  GlobalWorkspaceFallbackHandler,
  type RoutingContext,
} from "../src/router/chain.ts";
import { ProjectRouter } from "../src/router/project-router.ts";
import {
  GLOBAL_PROJECT_ID,
  DEFAULT_GLOBAL_PROMPT,
  createGlobalProjectConfig,
} from "../src/project/global.ts";
import { PromptManager } from "../src/project/prompts.ts";
import { WorkspaceManager } from "../src/workspace/workspace.ts";
import { GatewayService } from "../src/gateway/service.ts";
import { MemoryStore } from "../src/persistence/store.ts";
import { ProjectManager } from "../src/project/manager.ts";
import { Logger } from "../src/observability/logger.ts";
import type { ProjectConfig, SessionRoute } from "../src/domain/types.ts";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const mockProjects: ProjectConfig[] = [
  {
    id: "shortlink",
    displayName: "短链服务",
    description: "企业短链生成、跳转与统计分析系统",
    projectDir: "/tmp/mock/shortlink",
    routing: {
      projectId: "shortlink",
      displayName: "短链服务",
      summary: "短链生成与重定向服务",
      keywords: ["短链", "url", "redirect", "shortlink"],
      repositories: ["shortlink-web", "shortlink-api"],
    },
    repositories: [
      {
        id: "shortlink-api",
        url: "https://github.com/example/shortlink-api.git",
        baseBranch: "main",
        isPrimary: true,
      },
    ],
  },
  {
    id: "payment",
    displayName: "聚合支付中台",
    description: "提供微信、支付宝及银行卡清结算能力",
    projectDir: "/tmp/mock/payment",
    routing: {
      projectId: "payment",
      displayName: "聚合支付中台",
      summary: "支付通道与对账中心",
      keywords: ["支付", "pay", "wechat", "alipay"],
      repositories: ["payment-core"],
    },
    repositories: [
      {
        id: "payment-core",
        url: "https://github.com/example/payment-core.git",
        baseBranch: "master",
        isPrimary: true,
      },
    ],
  },
];

describe("3-Tier Decision Chain Router & Global Fallback", () => {
  describe("Tier 1: SessionStickyHandler", () => {
    test("routes directly to active existing session project with 1.0 confidence", async () => {
      const handler = new SessionStickyHandler();
      const activeSession: SessionRoute = {
        sessionId: "ses_123",
        projectId: "payment",
        runtimeSessionId: null,
        projectRuntimeId: "project-runtime:payment",
        configRevision: 1,
        status: "active",
        lastActiveAt: new Date().toISOString(),
      };

      const result = await handler.handle({
        query: "随便输入一些无关文本",
        projects: mockProjects,
        existingSession: activeSession,
      });

      expect(result).not.toBeNull();
      expect(result?.project.id).toBe("payment");
      expect(result?.tier).toBe("session");
      expect(result?.confidence).toBe(1.0);
    });

    test("ignores archived session and returns null to pass down chain", async () => {
      const handler = new SessionStickyHandler();
      const archivedSession: SessionRoute = {
        sessionId: "ses_archived",
        projectId: "payment",
        runtimeSessionId: null,
        projectRuntimeId: "project-runtime:payment",
        configRevision: 1,
        status: "archived",
        lastActiveAt: new Date().toISOString(),
      };

      const result = await handler.handle({
        query: "无关文本",
        projects: mockProjects,
        existingSession: archivedSession,
      });

      expect(result).toBeNull();
    });

    test("returns null when no existing session", async () => {
      const handler = new SessionStickyHandler();
      const result = await handler.handle({
        query: "短链相关需求",
        projects: mockProjects,
        existingSession: undefined,
      });

      expect(result).toBeNull();
    });
  });

  describe("Tier 2: KeywordMatchHandler", () => {
    test("routes immediately when query matches unique project keywords", async () => {
      const handler = new KeywordMatchHandler();
      const result = await handler.handle({
        query: "请帮我排查一下短链跳转 404 的问题",
        projects: mockProjects,
      });

      expect(result).not.toBeNull();
      expect(result?.project.id).toBe("shortlink");
      expect(result?.tier).toBe("keyword");
      expect(result?.confidence).toBeGreaterThanOrEqual(0.65);
    });

    test("routes on repository name matching", async () => {
      const handler = new KeywordMatchHandler();
      const result = await handler.handle({
        query: "check payment-core health",
        projects: mockProjects,
      });

      expect(result).not.toBeNull();
      expect(result?.project.id).toBe("payment");
      expect(result?.tier).toBe("keyword");
    });

    test("returns null when no keywords match to pass down chain", async () => {
      const handler = new KeywordMatchHandler();
      const result = await handler.handle({
        query: "请介绍一下公司的微服务架构整体设计",
        projects: mockProjects,
      });

      expect(result).toBeNull();
    });

    test("returns null on tie / ambiguous match to pass down to Jev", async () => {
      const ambiguousProjects: ProjectConfig[] = [
        {
          id: "service-a",
          displayName: "Service A",
          description: "Service A",
          projectDir: "/tmp/a",
          routing: { projectId: "service-a", summary: "A", keywords: ["common", "service"] },
          repositories: [],
        },
        {
          id: "service-b",
          displayName: "Service B",
          description: "Service B",
          projectDir: "/tmp/b",
          routing: { projectId: "service-b", summary: "B", keywords: ["common", "service"] },
          repositories: [],
        },
      ];

      const handler = new KeywordMatchHandler();
      const result = await handler.handle({
        query: "common service issue",
        projects: ambiguousProjects,
      });

      expect(result).toBeNull();
    });
  });

  describe("Tier 3: JevDecisionHandler (Aliyun decision-model-preview compatible)", () => {
    test("calls System One decision endpoint and routes on high confidence specific choice", async () => {
      let requestedUrl = "";
      let requestedBody: any = null;

      const mockFetch: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        requestedUrl = String(url);
        requestedBody = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            answers: {
              target_project: {
                choice: "shortlink",
                confidence: 0.92,
              },
              is_specific_project: {
                noul: 0.95,
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as any;

      const handler = new JevDecisionHandler({
        apiKey: "test-dashscope-key",
        model: "decision-model-preview",
        baseUrl: "https://dashscope.aliyuncs.com",
        fetchFn: mockFetch,
      });

      const result = await handler.handle({
        query: "帮我看一下生成一个营销活动的新跳转链接需要改哪里",
        projects: mockProjects,
      });

      expect(requestedUrl).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1/systemone");
      expect(requestedBody.model).toBe("decision-model-preview");
      expect(requestedBody.questions.target_project.type).toBe("choice");
      expect(requestedBody.questions.is_specific_project.type).toBe("noul");
      expect(result).not.toBeNull();
      expect(result?.project.id).toBe("shortlink");
      expect(result?.tier).toBe("jev");
      expect(result?.confidence).toBe(0.92);
    });

    test("seamlessly switches to official TypeSafe AI standard Jev endpoint with only baseUrl and model replaced", async () => {
      let requestedUrl = "";
      let requestedBody: any = null;

      const mockFetch: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        requestedUrl = String(url);
        requestedBody = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            model: "jev-latest",
            answers: {
              target_project: {
                type: "choice",
                choice: "payment",
                confidence: 0.98,
                probabilities: { payment: 0.98, shortlink: 0.02 },
              },
              is_specific_project: {
                type: "noul",
                noul: 0.99,
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as any;

      // Switch seamlessly to TypeSafe AI official Jev by replacing baseUrl and model
      const handler = new JevDecisionHandler({
        apiKey: "test-typesafe-key",
        baseUrl: "https://api.typesafe.ai",
        model: "jev-latest",
        fetchFn: mockFetch,
      });

      const result = await handler.handle({
        query: "退款请求在对账中心报错 signature verification failed",
        projects: mockProjects,
      });

      expect(requestedUrl).toBe("https://api.typesafe.ai/v1/systemone");
      expect(requestedBody.model).toBe("jev-latest");
      expect(result).not.toBeNull();
      expect(result?.project.id).toBe("payment");
      expect(result?.tier).toBe("jev");
      expect(result?.confidence).toBe(0.98);
    });

    test("passes down when Jev decides query is macro / non-specific (noul < 0.4)", async () => {
      const mockFetch: typeof fetch = (async () => {
        return new Response(
          JSON.stringify({
            answers: {
              target_project: {
                choice: "shortlink",
                confidence: 0.5,
              },
              is_specific_project: {
                noul: 0.1, // Macroscopic global query, not a specific project task
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as any;

      const handler = new JevDecisionHandler({
        apiKey: "test-dashscope-key",
        baseUrl: "https://dashscope.aliyuncs.com",
        fetchFn: mockFetch,
      });

      const result = await handler.handle({
        query: "系统的所有微服务之间是怎么通信的？",
        projects: mockProjects,
      });

      expect(result).toBeNull();
    });

    test("passes down on API error or network failure", async () => {
      const mockFetch: typeof fetch = (async () => {
        return new Response("Internal Server Error", { status: 500 });
      }) as any;

      const handler = new JevDecisionHandler({
        apiKey: "test-dashscope-key",
        fetchFn: mockFetch,
      });

      const result = await handler.handle({
        query: "some query",
        projects: mockProjects,
      });

      expect(result).toBeNull();
    });
  });

  describe("Tier 4: GlobalWorkspaceFallbackHandler", () => {
    test("returns global read-only project with fallback tier and flag", async () => {
      const globalConfig = createGlobalProjectConfig("/workspace/projects");
      const handler = new GlobalWorkspaceFallbackHandler(globalConfig);

      const result = await handler.handle({
        query: "请介绍一下整个系统的架构设计以及都有哪些工程",
        projects: mockProjects,
      });

      expect(result).not.toBeNull();
      expect(result.project.id).toBe(GLOBAL_PROJECT_ID);
      expect(result.tier).toBe("fallback_global");
      expect(result.isGlobalFallback).toBe(true);
      expect(result.project.runtime?.sandbox).toBe("danger-full-access");
    });
  });

  describe("Full Routing Pipeline & ProjectRouter Integration", () => {
    test("Pipeline prioritizes Session > Keyword > Jev > Global Fallback", async () => {
      const globalConfig = createGlobalProjectConfig();
      const pipeline = new RoutingPipeline()
        .addHandler(new SessionStickyHandler())
        .addHandler(new KeywordMatchHandler())
        .addHandler(new GlobalWorkspaceFallbackHandler(globalConfig));

      // 1. Session exists -> hits session tier immediately even if keywords say something else
      const sessionResult = await pipeline.execute({
        query: "短链相关",
        projects: mockProjects,
        existingSession: {
          sessionId: "ses_p",
          projectId: "payment",
          runtimeSessionId: null,
          projectRuntimeId: "rt:p",
          configRevision: 1,
          status: "active",
          lastActiveAt: new Date().toISOString(),
        },
      });
      expect(sessionResult.tier).toBe("session");
      expect(sessionResult.project.id).toBe("payment");

      // 2. No session, has keywords -> hits keyword tier
      const keywordResult = await pipeline.execute({
        query: "微信支付回调签名验证失败",
        projects: mockProjects,
      });
      expect(keywordResult.tier).toBe("keyword");
      expect(keywordResult.project.id).toBe("payment");

      // 3. No session, no keywords -> hits global fallback
      const fallbackResult = await pipeline.execute({
        query: "请问今天天气怎么样？整体架构图在哪看？",
        projects: mockProjects,
      });
      expect(fallbackResult.tier).toBe("fallback_global");
      expect(fallbackResult.project.id).toBe(GLOBAL_PROJECT_ID);
      expect(fallbackResult.isGlobalFallback).toBe(true);
    });

    test("ProjectRouter.route with enableGlobalFallback returns _global_ when no match", async () => {
      const router = new ProjectRouter();
      const decision = await router.route("完全无关的通用问答", mockProjects, {
        enableGlobalFallback: true,
      });

      expect(decision.project.id).toBe(GLOBAL_PROJECT_ID);
      expect(decision.tier).toBe("fallback_global");
      expect(decision.isGlobalFallback).toBe(true);
    });

    test("ProjectRouter.route preserves backward compatibility when enableGlobalFallback is false", async () => {
      const router = new ProjectRouter();
      // Should throw when no project matches and fallback is disabled
      await expect(
        router.route("完全无关的通用问答", mockProjects, { enableGlobalFallback: false }),
      ).rejects.toThrow("unable to route query to a project");
    });
  });

  describe("Global Workspace & Prompts", () => {
    const testDir = path.join(os.tmpdir(), `global-workspace-test-${Date.now()}`);

    test("WorkspaceManager creates global workspace without git worktree and generates default AGENTS.md", async () => {
      const globalProjectsDir = path.join(testDir, "projects");
      const globalProject = createGlobalProjectConfig(globalProjectsDir);
      const workspaces = new WorkspaceManager(
        path.join(testDir, "sessions"),
        path.join(testDir, "bases"),
      );

      const info = await workspaces.ensureSessionWorkspaces(globalProject, "ses_global_test");

      expect(info.sessionRoot).toBe(globalProjectsDir);
      expect(info.primaryPath).toBe(globalProjectsDir);
      expect(info.repoPaths.size).toBe(0); // No git worktree

      // Check AGENTS.md was created in global workspace
      const agentsMdPath = path.join(globalProjectsDir, "AGENTS.md");
      expect(existsSync(agentsMdPath)).toBe(true);
      const content = await readFile(agentsMdPath, "utf-8");
      expect(content).toContain("Global Overview Assistant");
      expect(content).toContain("Strict Read-Only Constraint");

      // removeSession should not delete the projects directory
      await workspaces.removeSession(globalProject, "ses_global_test");
      expect(existsSync(globalProjectsDir)).toBe(true);
    });

    test("PromptManager loads DEFAULT_GLOBAL_PROMPT for _global_ and supports custom override", async () => {
      const globalProjectsDir = path.join(testDir, "custom-global-projects");
      await mkdir(globalProjectsDir, { recursive: true });

      const globalProject = createGlobalProjectConfig(globalProjectsDir);
      const promptManager = new PromptManager();

      // Default prompt when no custom file exists
      const defaultLoaded = await promptManager.load(globalProject, "system");
      expect(defaultLoaded).toContain("Global Overview Assistant");

      // Custom global.md file override
      const customPrompt = "# 自定义全局助手提示词\n欢迎来到全景分析模式";
      await writeFile(path.join(globalProjectsDir, "global.md"), customPrompt, "utf-8");

      const customLoaded = await promptManager.load(globalProject, "system");
      expect(customLoaded).toBe(customPrompt);
    });

    test("GatewayService routes unmatched user query to _global_ workspace in read-only mode", async () => {
      const rootDir = path.join(testDir, "gateway-test");
      const projectsDir = path.join(rootDir, "projects");
      await mkdir(projectsDir, { recursive: true });

      const store = new MemoryStore();
      const logger = new Logger();
      const config = {
        dataDir: path.join(rootDir, "data"),
        artifactDir: path.join(rootDir, "artifacts"),
        workspaceRoot: path.join(rootDir, "workspaces"),
        server: { port: 0 },
      } as any;
      const projectManager = new ProjectManager(
        [
          {
            ...mockProjects[0]!,
            runtime: { type: "fake" },
          },
        ],
        store,
        config,
        logger,
      );

      const service = new GatewayService(config, store, projectManager, logger);

      // User asks macro architecture query that doesn't match any project keywords
      const created = await service.createSession({
        query: "请问我们系统有哪些核心业务模块？整体技术栈是什么？",
      });

      expect(created.session.projectId).toBe(GLOBAL_PROJECT_ID);
      expect(created.routedProject).toBe(GLOBAL_PROJECT_ID);

      const globalRuntime = projectManager.get(GLOBAL_PROJECT_ID);
      expect(globalRuntime.project.runtime?.sandbox).toBe("danger-full-access");
    });
  });
});
