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
import { PiNormalizer, asAssistantMessage, assistantText } from "./normalizer.ts";
import { bridgeActionsToPiTools } from "./tools.ts";
import {
  PI_THINKING_LEVELS,
  type PiProviderConfig,
  type PiRuntimeConfig,
  type PiSessionWrapper,
} from "./types.ts";

type ProviderInput = Parameters<ModelRuntime["registerProvider"]>[1];

/** Built-in tools of a read-only session. */
export const PI_READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];

/**
 * Native in-process AgentRuntime implementation for Pi Agent (@earendil-works/pi-coding-agent).
 */
export class PiRuntime implements AgentRuntime {
  readonly name = "pi";
  readonly type = "pi" as const;
  readonly capabilities: RuntimeCapabilities = PI_CAPABILITIES;

  private readonly sessions = new Map<string, PiSessionWrapper>();
  private models: Promise<ModelRuntime> | undefined;

  constructor(
    private readonly logger = new Logger(),
    private readonly config: PiRuntimeConfig = {},
    private readonly globalProject?: ProjectConfig | undefined,
    private readonly actionRegistry?: ActionRegistry | undefined,
    modelRuntime?: ModelRuntime | undefined,
    /** Service data directory; Pi's agent dir defaults to <dataDir>/pi/<projectId>. */
    private readonly dataDir = ".data",
  ) {
    if (modelRuntime) this.models = Promise.resolve(modelRuntime);
  }

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
  async releaseSession(_context: RuntimeContext, sessionId: string): Promise<void> {
    const wrapper = this.sessions.get(sessionId);
    if (!wrapper) return;
    this.sessions.delete(sessionId);
    await this.disposeSession(wrapper);
  }

  /**
   * Shuts down all active sessions and unloads the runtime adapter.
   */
  async stop(): Promise<void> {
    const wrappers = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(wrappers.map((wrapper) => this.disposeSession(wrapper)));
  }

  /** Stops a running turn before disposing, so nothing keeps working on a released session. */
  private async disposeSession(wrapper: PiSessionWrapper): Promise<void> {
    wrapper.unsubscribe?.();
    try {
      await wrapper.session.abort();
      wrapper.session.dispose();
    } catch (error) {
      this.logger.warn("failed to dispose pi session", { sessionId: wrapper.sessionId, error });
    }
  }

  // --------------------------------------------------------------------------
  // Internal Helpers
  // --------------------------------------------------------------------------

  private async setupSession(
    context: RuntimeContext,
    existingSessionId?: string,
  ): Promise<PiSessionWrapper> {
    const agentDir = this.agentDir(context.project);
    await mkdir(agentDir, { recursive: true });

    const sessionDir = join(agentDir, "sessions");
    await mkdir(sessionDir, { recursive: true });

    const settingsManager = SettingsManager.inMemory({
      packages: [],
      extensions: ["-*"],
      ...(this.config.settings ?? {}),
    });

    const modelRuntime = await this.modelRuntime(context.project);
    const model = this.resolveModel(context.project, modelRuntime);
    const thinkingLevel = this.thinkingLevel(context.project);
    const builtinTools = context.readOnly
      ? PI_READ_ONLY_TOOLS
      : (this.config.tools ?? ["read", "write", "edit", "bash"]);

    const wrapperHolder: { wrapper?: PiSessionWrapper } = {};

    let customTools: ToolDefinition[] = [];
    if (this.actionRegistry) {
      customTools = bridgeActionsToPiTools(this.actionRegistry, () => ({
        project: context.project,
        workspacePath: context.workspacePath,
        sessionId: wrapperHolder.wrapper?.sessionId ?? existingSessionId ?? "",
        turnId: wrapperHolder.wrapper?.currentTurnId,
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
    const serviceMcpServers = this.globalProject?.runtime?.mcpServers ?? [];
    const projectMcpServers = context.project.runtime?.mcpServers ?? [];
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

        const finished = event.type === "message_end" && asAssistantMessage(event.message);
        if (finished && assistantText(finished))
          wrapper.lastAssistantText = assistantText(finished);

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

          const lastMsg = asAssistantMessage(event.messages.at(-1));
          if (lastMsg?.stopReason === "error") {
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
          const error = event.finalError ?? "Auto retry failed";
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

  /** Pi's config directory for a project: models.json, auth.json and sessions live there. */
  private agentDir(project: ProjectConfig): string {
    return this.config.agentDir ?? resolve(this.dataDir, "pi", project.id);
  }

  /** The model registry with the configured providers, built once per runtime. */
  private modelRuntime(project: ProjectConfig): Promise<ModelRuntime> {
    this.models ??= this.createModelRuntime(project);
    return this.models;
  }

  private async createModelRuntime(project: ProjectConfig): Promise<ModelRuntime> {
    const agentDir = this.agentDir(project);
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    const providers: Record<string, PiProviderConfig> = {
      ...this.config.providers,
      ...(project.runtime?.providers as Record<string, PiProviderConfig> | undefined),
    };
    for (const [providerId, provider] of Object.entries(providers)) {
      // Entries mirror models.json; Pi validates them when they are registered.
      runtime.registerProvider(providerId, provider as unknown as ProviderInput);
      if (provider.apiKey) await runtime.setRuntimeApiKey(providerId, provider.apiKey);
    }
    return runtime;
  }

  /**
   * The model for a project: `runtime.model` (optionally "provider/model") or the configured
   * default. A model that is configured but unknown is an error; with none configured Pi
   * picks its own default.
   */
  private resolveModel(project: ProjectConfig, models: ModelRuntime): Model<any> | undefined {
    const modelId = project.runtime?.model ?? this.config.defaultModel;
    if (!modelId) return undefined;
    const providerId =
      typeof project.runtime?.provider === "string"
        ? project.runtime.provider
        : this.config.defaultProvider;
    const model = providerId
      ? models.getModel(providerId, modelId)
      : models.getModels().find((m) => m.id === modelId || `${m.provider}/${m.id}` === modelId);
    if (!model) {
      const available = models.getModels().map((m) => `${m.provider}/${m.id}`);
      throw new Error(
        `Pi model ${providerId ? `${providerId}/` : ""}${modelId} is not configured; known models: ${available.join(", ") || "none"}`,
      );
    }
    return model;
  }

  /** The project's `reasoningEffort` when Pi supports it, else the configured level. */
  private thinkingLevel(project: ProjectConfig): ThinkingLevel {
    const requested = project.runtime?.reasoningEffort;
    if (requested && (PI_THINKING_LEVELS as readonly string[]).includes(requested)) {
      return requested as ThinkingLevel;
    }
    return this.config.thinkingLevel ?? "medium";
  }
}

/** Pi rejects manual compaction of short or already compacted sessions with plain errors. */
function isNothingToCompact(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Nothing to compact") || message.includes("Already compacted");
}
