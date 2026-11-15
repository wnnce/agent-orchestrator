import type { ProjectConfig, SessionRoute } from "../domain/types.ts";
import { Logger } from "../observability/logger.ts";

export interface RoutingContext {
  query: string;
  projects: ProjectConfig[];
  existingSession?: SessionRoute | null | undefined;
  channel?: string | undefined;
  conversationId?: string | undefined;
  threadId?: string | undefined;
}

export interface RoutingResult {
  project: ProjectConfig;
  confidence: number;
  tier: "session" | "keyword" | "jev" | "fallback_global";
  reason: string;
  isGlobalFallback?: boolean | undefined;
}

export interface RoutingHandler {
  readonly name: string;
  handle(context: RoutingContext): Promise<RoutingResult | null>;
}

/**
 * Tier 1: Sticky Session Handler
 * If the session already exists and is active, directly lock onto its owning project.
 */
export class SessionStickyHandler implements RoutingHandler {
  readonly name = "session-sticky";

  async handle(context: RoutingContext): Promise<RoutingResult | null> {
    if (!context.existingSession) return null;
    if (context.existingSession.status === "archived") return null;

    const projectId = context.existingSession.projectId;
    const project = context.projects.find((p) => p.id === projectId);
    if (project) {
      return {
        project,
        confidence: 1.0,
        tier: "session",
        reason: `inherited from active session ${context.existingSession.sessionId}`,
      };
    }
    return null;
  }
}

/**
 * Tier 2: Keyword & Repository Match Handler
 * Matches project identifiers, keywords, and repository names directly in memory.
 */
export class KeywordMatchHandler implements RoutingHandler {
  readonly name = "keyword-match";

  async handle(context: RoutingContext): Promise<RoutingResult | null> {
    const text = context.query.toLowerCase();
    const scores = context.projects
      .map((project) => {
        const rawKeywords = [
          project.id,
          project.displayName,
          ...(project.routing.keywords ?? []),
          ...(project.routing.repositories ?? []),
        ]
          .map((k) => k.toLowerCase().trim())
          .filter(Boolean);

        const tokens = [
          project.id,
          project.displayName,
          project.description,
          ...(project.routing.keywords ?? []),
          ...(project.routing.repositories ?? []),
        ]
          .join(" ")
          .toLowerCase()
          .split(/[\s,.;:!?\/\\|()\[\]{}"'`~@#$%^&*+=<>，。！？（）【】「」《》、]+/)
          .filter(Boolean);

        const allTerms = Array.from(new Set([...rawKeywords, ...tokens]));

        return {
          project,
          score: allTerms.reduce((score, term) => score + (text.includes(term) ? 1 : 0), 0),
        };
      })
      .sort((a, b) => b.score - a.score);

    const top = scores[0];
    if (!top || top.score === 0) return null;

    // Ambiguity guard: If there is a tie, delegate to next tier (Jev or Fallback)
    if (scores[1] && scores[1].score === top.score) {
      return null;
    }

    const confidence = Math.min(0.95, 0.6 + top.score / 10);
    return {
      project: top.project,
      confidence,
      tier: "keyword",
      reason: `matched keyword for project ${top.project.id}`,
    };
  }
}

export interface JevRouterConfig {
  apiKey?: string;
  model?: string | undefined;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  logger?: Logger;
}

/**
 * Tier 3: Jev Structured Decision Model Handler
 * Direct invocation of standard Jev System One API (TypeSafe AI / DashScope decision-model-preview)
 */
export class JevDecisionHandler implements RoutingHandler {
  readonly name = "jev-decision";
  private readonly logger: Logger;

  constructor(private readonly config: JevRouterConfig = {}) {
    this.logger = config.logger ?? new Logger();
  }

  async handle(context: RoutingContext): Promise<RoutingResult | null> {
    const apiKey = this.config.apiKey?.trim();
    if (!apiKey) return null;
    if (context.projects.length === 0) return null;

    const model = this.config.model?.trim() || "decision-model-preview";
    const baseUrl = (this.config.baseUrl?.trim() || "https://dashscope.aliyuncs.com").replace(
      /\/+$/,
      "",
    );
    const fetchFn = this.config.fetchFn ?? fetch;

    const criteria: Record<string, string> = {};
    for (const p of context.projects) {
      criteria[p.id] = `${p.displayName}: ${p.description || p.routing.summary || p.id}`;
    }

    // Resolve and normalize standard Jev / System One API endpoint
    let endpoint = baseUrl;
    if (!endpoint.endsWith("/systemone")) {
      if (endpoint.includes("dashscope")) {
        const cleanBase = endpoint.replace(/\/compatible-mode(\/v1)?$/, "");
        endpoint = `${cleanBase}/compatible-mode/v1/systemone`;
      } else {
        const cleanBase = endpoint.replace(/\/v1$/, "");
        endpoint = `${cleanBase}/v1/systemone`;
      }
    }

    try {
      const response = await fetchFn(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          state: { query: context.query },
          questions: {
            target_project: {
              type: "choice",
              instructions: "Select the most appropriate project for the user request",
              criteria,
            },
            is_specific_project: {
              type: "noul",
              instructions:
                "Whether the user request pertains to specific code/feature development in a target project versus global inquiry",
            },
          },
        }),
      });

      if (!response.ok) {
        this.logger.debug("Jev System One request returned non-ok status", {
          status: response.status,
        });
        return null;
      }

      const data = (await response.json()) as any;
      const answers = data.answers ?? data;
      const targetChoice = answers.target_project;
      const isSpecific = answers.is_specific_project;

      if (!targetChoice || typeof targetChoice.choice !== "string") return null;

      const chosenProject = context.projects.find((p) => p.id === targetChoice.choice);
      if (!chosenProject) return null;

      const confidence =
        typeof targetChoice.confidence === "number" ? targetChoice.confidence : 0.8;
      const isSpecificProb = typeof isSpecific?.noul === "number" ? isSpecific.noul : 1.0;

      // Confidence >= 0.65 and classified as specific project task
      if (confidence >= 0.65 && isSpecificProb >= 0.4) {
        return {
          project: chosenProject,
          confidence,
          tier: "jev",
          reason: `Jev decision selected ${chosenProject.id} with confidence ${confidence.toFixed(2)}`,
        };
      }
      return null;
    } catch (err) {
      this.logger.debug("Jev System One call failed, passing to next tier", {
        error: (err as Error).message,
      });
      return null;
    }
  }
}

/**
 * Optional Chat Completions Model Router (OpenAI compatible)
 */
export class OpenAiDecisionHandler implements RoutingHandler {
  readonly name = "openai-decision";

  constructor(
    private readonly config: {
      apiKey: string;
      model?: string | undefined;
      baseUrl?: string;
      fetchFn?: typeof fetch;
      logger?: Logger;
    },
  ) {}

  async handle(context: RoutingContext): Promise<RoutingResult | null> {
    const apiKey = this.config.apiKey?.trim();
    if (!apiKey || context.projects.length === 0) return null;

    const model = this.config.model?.trim() || "gpt-4o-mini";
    const baseUrl = (this.config.baseUrl?.trim() || "https://api.openai.com/v1").replace(
      /\/+$/,
      "",
    );
    const fetchFn = this.config.fetchFn ?? fetch;

    try {
      const catalog = context.projects.map((p) => p.routing);
      const response = await fetchFn(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                "Choose exactly one project from the catalog for the user's query. Return JSON with projectId, confidence (0..1), and reason. If the query does not belong to any specific project, set confidence to 0.",
            },
            { role: "user", content: JSON.stringify({ query: context.query, projects: catalog }) },
          ],
        }),
      });

      if (!response.ok) return null;
      const data = (await response.json()) as any;
      const content = data.choices?.[0]?.message?.content;
      if (!content) return null;
      const parsed = JSON.parse(content);
      const project = context.projects.find((p) => p.id === parsed.projectId);
      if (!project) return null;
      const confidence = Number(parsed.confidence);
      if (confidence >= 0.65) {
        return {
          project,
          confidence,
          tier: "jev",
          reason: parsed.reason || "model route",
        };
      }
      return null;
    } catch {
      return null;
    }
  }
}

/**
 * Tier 4: Global Workspace Fallback Handler
 * Enters global read-only workspace when preceding tiers do not match
 */
export class GlobalWorkspaceFallbackHandler implements RoutingHandler {
  readonly name = "global-fallback";

  constructor(private readonly globalProject: ProjectConfig) {}

  async handle(_context: RoutingContext): Promise<RoutingResult> {
    return {
      project: this.globalProject,
      confidence: 0.5,
      tier: "fallback_global",
      reason: "no specific project matched; falling back to global read-only workspace",
      isGlobalFallback: true,
    };
  }
}

/**
 * Routing Pipeline
 */
export class RoutingPipeline {
  private readonly handlers: RoutingHandler[] = [];

  addHandler(handler: RoutingHandler): this {
    this.handlers.push(handler);
    return this;
  }

  async execute(context: RoutingContext): Promise<RoutingResult> {
    for (const handler of this.handlers) {
      const result = await handler.handle(context);
      if (result && (result as any).matched !== false) {
        return result;
      }
    }
    throw new Error("routing pipeline completed without matching any handler");
  }
}
