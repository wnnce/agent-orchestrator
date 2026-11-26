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
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { ActionRegistry } from "../../actions/registry.ts";
import type { ProjectConfig, TurnUsage } from "../../domain/types.ts";
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
import { projectSkillSources } from "../skills.ts";
import { buildTurnUsage, normalizeTokenUsage } from "../usage.ts";
import { PI_CAPABILITIES } from "./capabilities.ts";
import { PiNormalizer, asAssistantMessage, assistantText } from "./normalizer.ts";
import { bridgeActionsToPiTools } from "./tools.ts";
import { PI_THINKING_LEVELS, type PiSessionWrapper } from "./types.ts";

/** Built-in tools of a read-only session. */
export const PI_READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];

/**
 * Pi Agent (@earendil-works/pi-coding-agent) in process. Pi reads its own configuration from its
 * agent directory (PI_CODING_AGENT_DIR, by default ~/.pi/agent): settings, models.json, auth.json,
 * extensions and sessions. A session adds only what the project sets: model, thinking level, MCP
 * servers, orchestrator actions and skills, and read-only tools for a read-only session.
 */
export class PiRuntime implements AgentRuntime {
  readonly name = "pi";
  readonly type = "pi" as const;
  readonly capabilities: RuntimeCapabilities = PI_CAPABILITIES;

  private readonly sessions = new Map<string, PiSessionWrapper>();
  private models: Promise<ModelRuntime> | undefined;

  constructor(
    private readonly logger = new Logger(),
    private readonly globalProject?: ProjectConfig | undefined,
    private readonly actionRegistry?: ActionRegistry | undefined,
    modelRuntime?: ModelRuntime | undefined,
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
    wrapper.turnUsageEntries = [];
    wrapper.turnLastContextUsed = undefined;
    wrapper.isTurnEnded = false;

    // Run prompt asynchronously so startTurn returns immediately with runtimeTurnId
    wrapper.activeTurnPromise = (async () => {
      try {
        await wrapper.session.prompt(input);
      } catch (err) {
        if (!wrapper.isTurnEnded) {
          wrapper.isTurnEnded = true;
          const usage = consumePiTurnUsage(wrapper);
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
              ...(usage ? { usage } : {}),
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
    const usage = consumePiTurnUsage(wrapper);

    await context.onEvent({
      type: "turn.interrupted",
      sessionId,
      turnId: wrapper.currentTurnId,
      payload: {
        turnId: wrapper.currentTurnId,
        runtimeTurnId,
        status: "interrupted",
        ...(usage ? { usage } : {}),
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
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(context.workspacePath, agentDir);
    const modelRuntime = await this.modelRuntime();
    const model = this.resolveModel(context.project, modelRuntime);
    const thinkingLevel = this.thinkingLevel(context.project);

    const wrapperHolder: { wrapper?: PiSessionWrapper } = {};

    let customTools: ToolDefinition[] = [];
    if (this.actionRegistry) {
      customTools = bridgeActionsToPiTools(this.actionRegistry, () => ({
        project: context.project,
        workspacePath: context.workspacePath,
        sessionId: wrapperHolder.wrapper?.sessionId ?? existingSessionId ?? "",
        turnId: wrapperHolder.wrapper?.currentTurnId,
        taskKey: context.taskKey,
        actionScope: context.actionScope,
        actionParameterOverrides: context.actionParameterOverrides,
        createActionContext: context.createActionContext,
      }));
    }

    let sessionManager = SessionManager.create(context.workspacePath);
    if (existingSessionId) {
      const stored = await SessionManager.list(context.workspacePath);
      const match = stored.find((s) => s.id === existingSessionId);
      if (!match) throw new RuntimeSessionNotFoundError(existingSessionId);
      sessionManager = SessionManager.open(match.path);
    }

    const mcpServers = context.project.runtime?.mcpServers ?? [];
    const resourceLoader = new DefaultResourceLoader({
      cwd: context.workspacePath,
      agentDir,
      settingsManager,
      additionalSkillPaths: projectSkillSources(context.project, this.globalProject).map(
        (s) => s.dir,
      ),
      extensionFactories:
        mcpServers.length === 0
          ? []
          : [
              createMcpExtension({
                loadConfig: () => ({
                  servers: mcpServers.map((s) => ({
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

    const { session } = await createAgentSession({
      cwd: context.workspacePath,
      agentDir,
      modelRuntime,
      ...(model ? { model } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
      // Without an allowlist Pi enables its default tools plus the custom (action) tools.
      ...(context.readOnly ? { tools: PI_READ_ONLY_TOOLS } : {}),
      customTools,
      resourceLoader,
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
        if (finished) {
          if (assistantText(finished)) {
            wrapper.lastAssistantText = assistantText(finished);
          }
          recordPiAssistantUsage(wrapper, finished);
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

          const lastMsg = asAssistantMessage(event.messages.at(-1));
          const usage = consumePiTurnUsage(wrapper);
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
                ...(usage ? { usage } : {}),
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
              ...(usage ? { usage } : {}),
            },
          });
        } else if (event.type === "auto_retry_end" && !event.success && !wrapper.isTurnEnded) {
          wrapper.isTurnEnded = true;
          const usage = consumePiTurnUsage(wrapper);
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
              ...(usage ? { usage } : {}),
            },
          });
        } else if (event.type === "agent_settled" && event.aborted && !wrapper.isTurnEnded) {
          wrapper.isTurnEnded = true;
          const usage = consumePiTurnUsage(wrapper);
          await wrapper.context.onEvent({
            type: "turn.interrupted",
            sessionId: wrapper.sessionId,
            turnId: wrapper.currentTurnId,
            payload: {
              turnId: wrapper.currentTurnId,
              runtimeTurnId: wrapper.currentRuntimeTurnId,
              status: "interrupted",
              ...(usage ? { usage } : {}),
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

  /** Pi's model registry (models.json and auth.json in its agent directory), built once. */
  private modelRuntime(): Promise<ModelRuntime> {
    this.models ??= ModelRuntime.create();
    return this.models;
  }

  /**
   * The project's `runtime.model`, as "provider/model" or a model id. A model that is set but
   * unknown is an error; without one Pi uses its own default from settings.
   */
  private resolveModel(project: ProjectConfig, models: ModelRuntime): Model<any> | undefined {
    const modelId = project.runtime?.model;
    if (!modelId) return undefined;
    const model = models
      .getModels()
      .find((m) => `${m.provider}/${m.id}` === modelId || m.id === modelId);
    if (!model) {
      const available = models.getModels().map((m) => `${m.provider}/${m.id}`);
      throw new Error(
        `Pi model ${modelId} is not configured; known models: ${available.join(", ") || "none"}`,
      );
    }
    return model;
  }

  /** The project's `reasoningEffort` when Pi supports that level; otherwise Pi's own default. */
  private thinkingLevel(project: ProjectConfig): ThinkingLevel | undefined {
    const requested = project.runtime?.reasoningEffort;
    return requested && (PI_THINKING_LEVELS as readonly string[]).includes(requested)
      ? (requested as ThinkingLevel)
      : undefined;
  }
}

/** Pi rejects manual compaction of short or already compacted sessions with plain errors. */
function isNothingToCompact(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Nothing to compact") || message.includes("Already compacted");
}

function recordPiAssistantUsage(wrapper: PiSessionWrapper, message: AssistantMessage): void {
  const raw = message.usage as
    | (AssistantMessage["usage"] & { reasoning?: number | undefined })
    | undefined;
  if (!raw) return;
  const normalized = normalizeTokenUsage({
    inputTokens: raw.input,
    cacheReadTokens: raw.cacheRead,
    cacheWriteTokens: raw.cacheWrite,
    outputTokens: raw.output,
    reasoningTokens: raw.reasoning,
    inputIncludesCache: false,
  });
  if (normalized.totalTokens <= 0 && normalized.reasoningTokens <= 0) return;

  const model = message.model || wrapper.session.model?.id || "unknown";
  const provider = message.provider || wrapper.session.model?.provider;
  wrapper.turnUsageEntries ??= [];
  wrapper.turnUsageEntries.push({
    model,
    ...(provider ? { provider } : {}),
    ...normalized,
  });
  wrapper.turnLastContextUsed = normalized.totalTokens;
}

function consumePiTurnUsage(wrapper: PiSessionWrapper): TurnUsage | undefined {
  const entries = wrapper.turnUsageEntries ?? [];
  const contextUsedTokens = wrapper.turnLastContextUsed;
  wrapper.turnUsageEntries = [];
  wrapper.turnLastContextUsed = undefined;
  if (entries.length === 0) return undefined;

  return buildTurnUsage(entries, {
    primaryModel: wrapper.session.model?.id,
    contextUsedTokens,
    contextWindowTokens: wrapper.session.model?.contextWindow,
  });
}
