import type { ProjectConfig, SessionRoute } from "../domain/types.ts";
import { Logger } from "../observability/logger.ts";
import {
  RoutingPipeline,
  SessionStickyHandler,
  KeywordMatchHandler,
  JevDecisionHandler,
  GlobalWorkspaceFallbackHandler,
  scoreProjectKeywords,
  type RoutingResult,
  type RoutingContext,
} from "./chain.ts";
import { GLOBAL_PROJECT_ID, createGlobalProjectConfig } from "../project/global.ts";

export interface ProjectRouterOptions {
  existingSession?: SessionRoute | null;
  enableGlobalFallback?: boolean;
  globalProject?: ProjectConfig;
  channel?: string;
  conversationId?: string;
  threadId?: string;
}

export class ProjectRouter {
  private readonly defaultGlobalProject: ProjectConfig;

  constructor(
    private readonly apiKey?: string,
    private readonly model?: string,
    private readonly baseUrl = "https://api.openai.com/v1",
    private readonly logger = new Logger(),
  ) {
    this.defaultGlobalProject = createGlobalProjectConfig();
  }

  async route(
    query: string,
    projects: ProjectConfig[],
    options?: ProjectRouterOptions,
  ): Promise<{
    project: ProjectConfig;
    confidence: number;
    reason: string;
    tier?: string;
    isGlobalFallback?: boolean | undefined;
  }> {
    if (!query.trim()) throw new Error("query is required for project routing");
    if (projects.length === 0) throw new Error("no projects configured");

    const globalProject =
      options?.globalProject ??
      projects.find((p) => p.id === GLOBAL_PROJECT_ID) ??
      this.defaultGlobalProject;

    const pipeline = new RoutingPipeline();

    // 1. Tier 1: Sticky Session routing
    pipeline.addHandler(new SessionStickyHandler());

    // 2. Tier 2: Keyword & repository match
    pipeline.addHandler(new KeywordMatchHandler());

    // 3. Tier 3: Jev / Decision model routing
    if (this.apiKey) {
      pipeline.addHandler(
        new JevDecisionHandler({
          apiKey: this.apiKey,
          model: this.model,
          baseUrl: this.baseUrl,
          logger: this.logger,
        }),
      );
    }

    // 4. Tier 4: Global workspace fallback strategy
    if (options?.enableGlobalFallback) {
      pipeline.addHandler(new GlobalWorkspaceFallbackHandler(globalProject));
    }

    const context: RoutingContext = {
      query,
      projects,
      existingSession: options?.existingSession,
      channel: options?.channel,
      conversationId: options?.conversationId,
      threadId: options?.threadId,
    };

    try {
      const decision = await pipeline.execute(context);
      return {
        project: decision.project,
        confidence: decision.confidence,
        reason: decision.reason,
        tier: decision.tier,
        isGlobalFallback: decision.isGlobalFallback,
      };
    } catch {
      // Attribute deterministic error when all tiers miss and fallback is disabled
      return this.throwAmbiguousOrNotFound(query, projects);
    }
  }

  private throwAmbiguousOrNotFound(query: string, projects: ProjectConfig[]): never {
    const scores = scoreProjectKeywords(query, projects);
    const top = scores[0];
    if (top && scores[1] && scores[1].score === top.score && top.score > 0) {
      throw new Error("project routing is ambiguous");
    }
    throw new Error("unable to route query to a project");
  }
}
