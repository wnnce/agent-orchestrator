import { join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import {
  createAgentSession,
  createMcpExtension,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { ActionRegistry } from "../../actions/registry.ts";
import type { McpServerConfig, ProjectConfig } from "../../domain/types.ts";
import { Logger } from "../../observability/logger.ts";
import type {
  AgentRuntime,
  ApprovalDecision,
  RuntimeCapabilities,
  RuntimeContext,
  RuntimeSession,
  RuntimeTurn,
} from "../runtime.ts";
import { RuntimeSessionNotFoundError } from "../runtime.ts";
import { PI_CAPABILITIES } from "./capabilities.ts";
import { PiNormalizer } from "./normalizer.ts";
import { bridgeActionsToPiTools } from "./tools.ts";
import type { PiProviderConfig, PiRuntimeConfig, PiSessionWrapper } from "./types.ts";

/**
 * Native in-process AgentRuntime implementation for Pi Agent (@earendil-works/pi-coding-agent).
 */
export class PiRuntime implements AgentRuntime {
  readonly name = "pi";
  readonly type = "pi" as const;
  readonly capabilities: RuntimeCapabilities = PI_CAPABILITIES;

  private readonly sessions = new Map<string, PiSessionWrapper>();
  private defaultModelRuntime?: ModelRuntime | undefined;

  constructor(
    private readonly logger = new Logger(),
    private readonly config: PiRuntimeConfig = {},
    private readonly globalProject?: ProjectConfig | undefined,
    private readonly actionRegistry?: ActionRegistry | undefined,
    private readonly modelRuntimeOverride?: ModelRuntime | undefined,
  ) {}

  /**
   * Starts a new in-process Pi AgentSession confined to context.workspacePath.
   */
  async startSession(context: RuntimeContext): Promise<RuntimeSession> {
    const wrapper = await this.setupSession(context);
    return { id: wrapper.sessionId, workspacePath: context.workspacePath };
  }

  /**
   * Resumes an existing Pi AgentSession or creates a session initialized from persisted transcript.
   */
  async resumeSession(context: RuntimeContext, runtimeSessionId: string): Promise<RuntimeSession> {
    if (this.sessions.has(runtimeSessionId)) {
      const wrapper = this.sessions.get(runtimeSessionId)!;
      wrapper.context = context;
      return { id: runtimeSessionId, workspacePath: context.workspacePath };
    }

    const wrapper = await this.setupSession(context, runtimeSessionId);
    return { id: wrapper.sessionId, workspacePath: context.workspacePath };
  }

  /**
   * Enqueues and initiates a turn within the active Pi AgentSession.
   */
  async startTurn(
    context: RuntimeContext,
    sessionId: string,
    turnId: string,
    input: string,
  ): Promise<RuntimeTurn> {
    const wrapper = this.sessions.get(sessionId);
    if (!wrapper) {
      throw new Error(`Pi session not found: ${sessionId}`);
    }

    wrapper.context = context;
    wrapper.currentTurnId = turnId;
    const runtimeTurnId = `pi_turn_${crypto.randomUUID()}`;
    wrapper.currentRuntimeTurnId = runtimeTurnId;
    wrapper.lastAssistantText = undefined;
    wrapper.isTurnEnded = false;

    // Run prompt asynchronously so startTurn returns immediately with runtimeTurnId
    wrapper.activeTurnPromise = (async () => {
      try {
        await wrapper.session.prompt(input);
      } catch (err) {
        if (!wrapper.isTurnEnded) {
          wrapper.isTurnEnded = true;
          const errorMsg = err instanceof Error ? err.message : String(err);
          this.logger.error("Pi session prompt execution failed", {
            sessionId,
            turnId,
            error: errorMsg,
          });
          await wrapper.context.onEvent({
            type: "turn.failed",
            sessionId,
            turnId,
            payload: {
              turnId,
              runtimeTurnId,
              status: "failed",
              error: errorMsg,
            },
          });
        }
      }
    })();

    return { id: runtimeTurnId };
  }

  /**
   * Steers an in-flight turn with immediate guidance.
   */
  async steerTurn(
    context: RuntimeContext,
    sessionId: string,
    _runtimeTurnId: string,
    input: string,
  ): Promise<void> {
    const wrapper = this.sessions.get(sessionId);
    if (!wrapper) return;

    await wrapper.session.steer(input);
  }

  /**
   * Aborts the active turn.
   */
  async interruptTurn(
    context: RuntimeContext,
    sessionId: string,
    runtimeTurnId: string,
  ): Promise<void> {
    const wrapper = this.sessions.get(sessionId);
    if (!wrapper) return;

    wrapper.isTurnEnded = true;
    await wrapper.session.abort();

    await context.onEvent({
      type: "turn.interrupted",
      sessionId,
      turnId: wrapper.currentTurnId,
      payload: {
        turnId: wrapper.currentTurnId,
        runtimeTurnId,
        status: "interrupted",
      },
    });
  }

  /**
   * Triggers manual LLM-driven message compaction.
   */
  async compactSession(context: RuntimeContext, sessionId: string): Promise<void> {
    const wrapper = this.sessions.get(sessionId);
    if (!wrapper) return;

    try {
      await wrapper.session.compact();
    } catch (error) {
      if (!isNothingToCompact(error)) throw error;
      this.logger.debug("pi compaction skipped", { sessionId, reason: String(error) });
    }
  }

  /**
   * Approval response hook (Pi executes tools directly or via hooks).
   */
  async respondToApproval(
    _context: RuntimeContext,
    _requestId: string,
    _decision: ApprovalDecision,
  ): Promise<void> {}

  /**
   * Disposes and frees an individual session and its listeners.
   */
  async releaseSession(context: RuntimeContext, sessionId: string): Promise<void> {
    const wrapper = this.sessions.get(sessionId);
    if (!wrapper) return;

    if (wrapper.unsubscribe) wrapper.unsubscribe();
    wrapper.session.dispose();
    this.sessions.delete(sessionId);
  }

  /**
   * Shuts down all active sessions and unloads the runtime adapter.
   */
  async stop(): Promise<void> {
    for (const [_, wrapper] of this.sessions) {
      if (wrapper.unsubscribe) wrapper.unsubscribe();
      try {
        wrapper.session.dispose();
      } catch {}
    }
    this.sessions.clear();
  }

  // --------------------------------------------------------------------------
  // Internal Helpers
  // --------------------------------------------------------------------------

  private async setupSession(
    context: RuntimeContext,
    existingSessionId?: string,
  ): Promise<PiSessionWrapper> {
    const agentDir = this.config.agentDir ?? resolve(".data/pi", context.project.id);
    await mkdir(agentDir, { recursive: true });

    const sessionDir = join(agentDir, "sessions");
    await mkdir(sessionDir, { recursive: true });

    const settingsManager = SettingsManager.inMemory({
      packages: [],
      extensions: ["-*"],
      ...(this.config.settings ?? {}),
    });

    const modelRuntime = await this.resolveModelRuntime(context);
    const { model, thinkingLevel, builtinTools } = await this.resolveModelAndTools(
      context,
      modelRuntime,
    );

    const wrapperHolder: { wrapper?: PiSessionWrapper } = {};

    let customTools: ToolDefinition[] = [];
    if (this.actionRegistry) {
      customTools = bridgeActionsToPiTools(this.actionRegistry, () => ({
        project: context.project,
        workspacePath: context.workspacePath,
        sessionId: wrapperHolder.wrapper?.sessionId ?? existingSessionId ?? "",
        currentTurnId: wrapperHolder.wrapper?.currentTurnId,
        taskKey: context.taskKey,
        createActionContext: context.createActionContext,
      }));
    }

    const allTools = [...builtinTools, ...customTools.map((t) => t.name)];

    // Session persistence handling
    let sessionManager = SessionManager.create(context.workspacePath, sessionDir);
    if (existingSessionId) {
      const stored = await SessionManager.list(context.workspacePath, sessionDir);
      const match = stored.find((s) => s.id === existingSessionId);
      if (!match) throw new RuntimeSessionNotFoundError(existingSessionId);
      sessionManager = SessionManager.open(match.path);
    }

    // MCP extension handling
    let resourceLoader: DefaultResourceLoader | undefined;
    const serviceMcpServers = (this.globalProject?.runtime?.mcpServers ??
      this.globalProject?.agent?.mcpServers ??
      []) as McpServerConfig[];
    const projectMcpServers = (context.project.runtime?.mcpServers ??
      context.project.agent?.mcpServers ??
      []) as McpServerConfig[];
    const allMcpServers = [...serviceMcpServers, ...projectMcpServers];

    if (allMcpServers.length > 0) {
      resourceLoader = new DefaultResourceLoader({
        cwd: context.workspacePath,
        agentDir,
        extensionFactories: [
          createMcpExtension({
            loadConfig: () => ({
              servers: allMcpServers.map((s) => ({
                name: s.name,
                config: s.url
                  ? {
                      url: s.url,
                      ...(s.headers || s.http_headers
                        ? { headers: (s.headers ?? s.http_headers)! }
                        : {}),
                    }
                  : {
                      command: s.command ?? "bash",
                      ...(s.args ? { args: s.args } : {}),
                    },
                source: "orchestrator",
                scope: "project" as const,
              })),
              errors: [],
            }),
          }),
        ],
      });
      await resourceLoader.reload();
    }

    const { session } = await createAgentSession({
      cwd: context.workspacePath,
      agentDir,
      modelRuntime,
      ...(model ? { model } : {}),
      thinkingLevel,
      tools: allTools,
      customTools,
      ...(resourceLoader ? { resourceLoader } : {}),
      sessionManager,
      settingsManager,
    });

    const wrapper: PiSessionWrapper = {
      session,
      sessionId: session.sessionId,
      workspacePath: context.workspacePath,
      context,
    };
    wrapperHolder.wrapper = wrapper;

    const unsubscribe = session.subscribe(async (event) => {
      try {
        // Accumulate final assistant message text
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          wrapper.lastAssistantText =
            (wrapper.lastAssistantText ?? "") + event.assistantMessageEvent.delta;
        }

        if (event.type === "message_end" && event.message?.role === "assistant") {
          const fullText = Array.isArray(event.message.content)
            ? event.message.content
                .filter((c: any) => c && c.type === "text" && typeof c.text === "string")
                .map((c: any) => c.text)
                .join("")
            : "";
          if (fullText) {
            wrapper.lastAssistantText = fullText;
          }
        }

        const canonicalEvents = PiNormalizer.normalize(
          event,
          wrapper.sessionId,
          wrapper.currentTurnId,
        );

        for (const ce of canonicalEvents) {
          await wrapper.context.onEvent(ce);
        }

        // Completion and failure handling
        if (event.type === "agent_end" && !wrapper.isTurnEnded) {
          if (event.willRetry) {
            return;
          }

          const lastMsg = event.messages[event.messages.length - 1] as any;
          if (lastMsg && lastMsg.stopReason === "error") {
            wrapper.isTurnEnded = true;
            const error = lastMsg.errorMessage ?? "Turn failed";
            await wrapper.context.onEvent({
              type: "turn.failed",
              sessionId: wrapper.sessionId,
              turnId: wrapper.currentTurnId,
              payload: {
                turnId: wrapper.currentTurnId,
                runtimeTurnId: wrapper.currentRuntimeTurnId,
                status: "failed",
                error,
              },
            });
            return;
          }

          wrapper.isTurnEnded = true;
          await wrapper.context.onEvent({
            type: "turn.completed",
            sessionId: wrapper.sessionId,
            turnId: wrapper.currentTurnId,
            payload: {
              turnId: wrapper.currentTurnId,
              runtimeTurnId: wrapper.currentRuntimeTurnId,
              status: "completed",
              finalText: wrapper.lastAssistantText,
            },
          });
        } else if (event.type === "auto_retry_end" && !event.success && !wrapper.isTurnEnded) {
          wrapper.isTurnEnded = true;
          const error = (event as any).finalError ?? "Auto retry failed";
          await wrapper.context.onEvent({
            type: "turn.failed",
            sessionId: wrapper.sessionId,
            turnId: wrapper.currentTurnId,
            payload: {
              turnId: wrapper.currentTurnId,
              runtimeTurnId: wrapper.currentRuntimeTurnId,
              status: "failed",
              error,
            },
          });
        } else if (event.type === "agent_settled" && event.aborted && !wrapper.isTurnEnded) {
          wrapper.isTurnEnded = true;
          await wrapper.context.onEvent({
            type: "turn.interrupted",
            sessionId: wrapper.sessionId,
            turnId: wrapper.currentTurnId,
            payload: {
              turnId: wrapper.currentTurnId,
              runtimeTurnId: wrapper.currentRuntimeTurnId,
              status: "interrupted",
            },
          });
        }
      } catch (err) {
        this.logger.error("error dispatching Pi runtime event", {
          sessionId: wrapper.sessionId,
          turnId: wrapper.currentTurnId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    wrapper.unsubscribe = unsubscribe;
    this.sessions.set(session.sessionId, wrapper);
    return wrapper;
  }

  private async resolveModelRuntime(context: RuntimeContext): Promise<ModelRuntime> {
    if (this.modelRuntimeOverride) {
      return this.modelRuntimeOverride;
    }
    if (!this.defaultModelRuntime) {
      this.defaultModelRuntime = await ModelRuntime.create(
        this.config.agentDir
          ? {
              authPath: join(this.config.agentDir, "auth.json"),
              modelsPath: join(this.config.agentDir, "models.json"),
            }
          : {},
      );
    }
    const runtime = this.defaultModelRuntime;

    const runtimeConf = (context.project.runtime ?? {}) as Record<string, any>;
    const combinedProviders: Record<string, PiProviderConfig> = {
      ...(this.config.providers ?? {}),
      ...(runtimeConf.providers ?? {}),
    };

    // Shorthand for single-provider config
    const singleProvider = runtimeConf.provider ?? this.config.provider;
    if (singleProvider && !combinedProviders[singleProvider]) {
      const singleApiKey =
        typeof runtimeConf.apiKey === "string" ? runtimeConf.apiKey : this.config.apiKey;
      const singleBaseUrl =
        typeof runtimeConf.baseUrl === "string" ? runtimeConf.baseUrl : this.config.baseUrl;
      const singleApi = typeof runtimeConf.api === "string" ? runtimeConf.api : this.config.api;
      const singleHeaders =
        runtimeConf.headers && typeof runtimeConf.headers === "object"
          ? (runtimeConf.headers as Record<string, string>)
          : this.config.headers;
      const singleModels = Array.isArray(runtimeConf.models)
        ? runtimeConf.models
        : this.config.models;

      if (singleBaseUrl || singleApiKey || singleApi || singleHeaders || singleModels) {
        combinedProviders[singleProvider] = {
          ...(singleBaseUrl ? { baseUrl: singleBaseUrl } : {}),
          ...(singleApiKey ? { apiKey: singleApiKey } : {}),
          ...(singleApi ? { api: singleApi } : {}),
          ...(singleHeaders ? { headers: singleHeaders } : {}),
          ...(singleModels ? { models: singleModels } : {}),
        };
      }
    }

    for (const [providerId, providerDef] of Object.entries(combinedProviders)) {
      if (providerDef && typeof providerDef === "object") {
        runtime.registerProvider(providerId, providerDef as any);
        if (typeof providerDef.apiKey === "string" && providerDef.apiKey) {
          await runtime.setRuntimeApiKey(providerId, providerDef.apiKey);
        }
      }
    }

    return runtime;
  }

  private async resolveModelAndTools(
    context: RuntimeContext,
    modelRuntime: ModelRuntime,
  ): Promise<{
    model?: Model<any> | undefined;
    thinkingLevel: ThinkingLevel;
    builtinTools: string[];
  }> {
    const runtimeConf = (context.project.runtime ?? {}) as Record<string, any>;
    const provider =
      runtimeConf.defaultProvider ??
      runtimeConf.provider ??
      this.config.defaultProvider ??
      this.config.provider;
    const modelId =
      typeof runtimeConf.defaultModel === "string"
        ? runtimeConf.defaultModel
        : typeof runtimeConf.model === "string"
          ? runtimeConf.model
          : (context.project.agent?.model ?? this.config.defaultModel ?? this.config.model);

    let model: Model<any> | undefined;
    if (provider && modelId) {
      model = modelRuntime.getModel(String(provider), modelId);
    } else if (modelId) {
      const allModels = modelRuntime.getModels();
      model = allModels.find((m) => m.id === modelId || `${m.provider}/${m.id}` === modelId);
    }

    if (!model) {
      const available = await modelRuntime.getAvailable();
      if (available.length > 0) {
        model = available[0];
      }
    }

    const rawThinking =
      runtimeConf.thinkingLevel ??
      runtimeConf.reasoningEffort ??
      this.config.thinkingLevel ??
      "medium";
    const thinkingLevel: ThinkingLevel = normalizeThinkingLevel(rawThinking);

    const builtinTools = this.config.tools ?? ["read", "write", "edit", "bash"];

    return { model, thinkingLevel, builtinTools };
  }
}

/** Pi rejects manual compaction of short or already compacted sessions with plain errors. */
function isNothingToCompact(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Nothing to compact") || message.includes("Already compacted");
}

function normalizeThinkingLevel(level: unknown): ThinkingLevel {
  switch (level) {
    case "off":
    case "low":
    case "medium":
    case "high":
      return level;
    case "minimal":
      return "low";
    default:
      return "medium";
  }
}
