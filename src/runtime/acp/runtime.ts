import {
  RequestError,
  type McpServer,
  type PermissionOption,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionNotification,
  type ToolKind,
} from "@agentclientprotocol/sdk";
import { ActionRegistry, defaultActionRegistry } from "../../actions/index.ts";
import type { ApprovalRequestedPayload } from "../../domain/events.ts";
import type { ProjectConfig } from "../../domain/types.ts";
import { Logger } from "../../observability/logger.ts";
import {
  RuntimeSessionNotFoundError,
  type AgentRuntime,
  type ApprovalDecision,
  type RuntimeCapabilities,
  type RuntimeContext,
  type RuntimeEvent,
  type RuntimeSession,
  type RuntimeTurn,
} from "../runtime.ts";
import { ACPClient } from "./client.ts";
import { ACPMcpBridge, ACP_ACTION_SERVER_NAME } from "./mcp-bridge.ts";
import { ACPNormalizer } from "./normalizer.ts";
import {
  resolveStandardConfigUpdates,
  toACPMcpServers,
  type ACPProfile,
} from "./profile.ts";
import { prepareACPSkillDirectories } from "./skills.ts";
import {
  extractACPActiveModel,
  extractACPPromptUsage,
  extractACPResponseModels,
  normalizeACPPromptUsage,
} from "./usage.ts";

interface ActiveACPTurn {
  readonly id: string;
  readonly turnId: string;
  canceled: boolean;
  settled: boolean;
  finalText?: string | undefined;
}

interface ManagedACPSession {
  readonly sessionId: string;
  readonly bridgeSessionId: string;
  readonly normalizer: ACPNormalizer;
  readonly orchestratorTools: Set<string>;
  context: RuntimeContext;
  activeTurn?: ActiveACPTurn | undefined;
  activeModel?: string | undefined;
  contextUsedTokens?: number | undefined;
  contextWindowTokens?: number | undefined;
  compacting: boolean;
  compactionReported: boolean;
  eventChain: Promise<void>;
}

interface PendingACPPermission {
  readonly sessionId: string;
  readonly options: readonly PermissionOption[];
  resolve(response: RequestPermissionResponse): void;
}

const READ_ONLY_TOOL_KINDS: ReadonlySet<ToolKind> = new Set(["read", "search", "think"]);
const MCP_ORCHESTRATOR_PREFIX = `mcp__${ACP_ACTION_SERVER_NAME}__`;

function selectPermissionOption(
  options: readonly PermissionOption[],
  decision: ApprovalDecision,
): RequestPermissionResponse {
  const preferredKinds: readonly PermissionOption["kind"][] =
    decision === "approved" ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const kind of preferredKinds) {
    const match = options.find((opt) => opt.kind === kind);
    if (match) {
      return { outcome: { outcome: "selected", optionId: match.optionId } };
    }
  }
  return { outcome: { outcome: "cancelled" } };
}

function mapActionType(kind: ToolKind | null | undefined): ApprovalRequestedPayload["actionType"] {
  switch (kind) {
    case "execute":
      return "command";
    case "edit":
    case "delete":
    case "move":
      return "file_change";
    default:
      return "tool_call";
  }
}

function isResourceNotFoundError(error: unknown): boolean {
  if (error instanceof RequestError && error.code === -32002) return true;
  const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return msg.includes("session not found") || msg.includes("unknown session");
}

/**
 * Generic Agent Client Protocol (`@agentclientprotocol/sdk`) runtime adapter parameterized by an
 * `ACPProfile`. One ACP client subprocess serves one project runtime lazily on first session use.
 */
export class ACPRuntime implements AgentRuntime {
  readonly name: string;
  readonly type: string;
  readonly capabilities: RuntimeCapabilities;

  private client: ACPClient | undefined;
  private connecting: Promise<ACPClient> | undefined;
  private readonly sessions = new Map<string, ManagedACPSession>();
  private readonly pendingApprovals = new Map<string, PendingACPPermission>();
  private readonly mcpBridge: ACPMcpBridge;

  constructor(
    private readonly profile: ACPProfile,
    private readonly logger = new Logger(),
    private readonly globalProject?: ProjectConfig | undefined,
    private readonly actionRegistry: ActionRegistry = defaultActionRegistry,
    private readonly dataDir = ".data",
  ) {
    this.name = profile.name;
    this.type = profile.type;
    this.capabilities = profile.capabilities;
    this.mcpBridge = new ACPMcpBridge(this.actionRegistry);
  }

  async startSession(context: RuntimeContext): Promise<RuntimeSession> {
    const client = await this.connect(context.project, Boolean(context.readOnly));
    const bridgeSessionId = crypto.randomUUID();
    const { mcpServers, orchestratorTools } = this.buildMcpServers(context, bridgeSessionId);
    const additionalDirectories = await this.resolveAdditionalDirectories(client, context);

    const managed: ManagedACPSession = {
      sessionId: "",
      bridgeSessionId,
      normalizer: new ACPNormalizer(),
      orchestratorTools,
      context,
      compacting: false,
      compactionReported: false,
      eventChain: Promise.resolve(),
    };

    this.mcpBridge.registerSession(bridgeSessionId, () => ({
      project: managed.context.project,
      workspacePath: managed.context.workspacePath,
      sessionId: managed.sessionId,
      turnId: managed.activeTurn?.turnId,
      taskKey: managed.context.taskKey,
      actionScope: managed.context.actionScope,
      createActionContext: managed.context.createActionContext,
      logger: this.logger,
    }));

    try {
      const response = await client.newSession({
        cwd: context.workspacePath,
        mcpServers,
        additionalDirectories,
      });
      const initialized: ManagedACPSession = {
        ...managed,
        sessionId: response.sessionId,
        activeModel:
          extractACPActiveModel(response.configOptions, extractACPResponseModels(response)) ??
          context.project.runtime?.model,
      };
      this.sessions.set(response.sessionId, initialized);
      await this.applySessionSettings(client, initialized, context, response.configOptions);
      return { id: response.sessionId, workspacePath: context.workspacePath };
    } catch (error) {
      this.mcpBridge.unregisterSession(bridgeSessionId);
      throw error;
    }
  }

  async resumeSession(
    context: RuntimeContext,
    runtimeSessionId: string,
  ): Promise<RuntimeSession> {
    const existing = this.sessions.get(runtimeSessionId);
    if (existing) {
      existing.context = context;
      return { id: runtimeSessionId, workspacePath: context.workspacePath };
    }

    const client = await this.connect(context.project, Boolean(context.readOnly));
    const bridgeSessionId = crypto.randomUUID();
    const { mcpServers, orchestratorTools } = this.buildMcpServers(context, bridgeSessionId);
    const additionalDirectories = await this.resolveAdditionalDirectories(client, context);

    const managed: ManagedACPSession = {
      sessionId: runtimeSessionId,
      bridgeSessionId,
      normalizer: new ACPNormalizer(),
      orchestratorTools,
      context,
      compacting: false,
      compactionReported: false,
      eventChain: Promise.resolve(),
    };

    this.mcpBridge.registerSession(bridgeSessionId, () => ({
      project: managed.context.project,
      workspacePath: managed.context.workspacePath,
      sessionId: runtimeSessionId,
      turnId: managed.activeTurn?.turnId,
      taskKey: managed.context.taskKey,
      actionScope: managed.context.actionScope,
      createActionContext: managed.context.createActionContext,
      logger: this.logger,
    }));

    try {
      const caps = client.agentCapabilities;
      let configOptions: readonly SessionConfigOption[] | null | undefined;
      let models: { currentModelId?: string | null | undefined } | null | undefined;
      if (caps.sessionCapabilities?.resume) {
        const res = await client.resumeSession({
          sessionId: runtimeSessionId,
          cwd: context.workspacePath,
          mcpServers,
          additionalDirectories,
        });
        configOptions = res.configOptions;
        models = extractACPResponseModels(res);
      } else if (caps.loadSession) {
        const res = await client.loadSession({
          sessionId: runtimeSessionId,
          cwd: context.workspacePath,
          mcpServers,
          additionalDirectories,
        });
        configOptions = res && typeof res === "object" ? res.configOptions : undefined;
        models = extractACPResponseModels(res);
      } else {
        throw new RuntimeSessionNotFoundError(runtimeSessionId);
      }

      managed.activeModel =
        extractACPActiveModel(configOptions, models) ?? context.project.runtime?.model;
      this.sessions.set(runtimeSessionId, managed);
      await this.applySessionSettings(client, managed, context, configOptions);
      return { id: runtimeSessionId, workspacePath: context.workspacePath };
    } catch (error) {
      this.mcpBridge.unregisterSession(bridgeSessionId);
      const isMissing =
        this.profile.isSessionNotFoundError?.(error) ?? isResourceNotFoundError(error);
      if (isMissing) {
        throw new RuntimeSessionNotFoundError(runtimeSessionId);
      }
      throw error;
    }
  }

  async startTurn(
    context: RuntimeContext,
    sessionId: string,
    turnId: string,
    input: string,
  ): Promise<RuntimeTurn> {
    const client = await this.connect(context.project, Boolean(context.readOnly));
    const session = this.requireSession(sessionId);
    session.context = context;

    if (session.activeTurn && !session.activeTurn.settled) {
      throw new Error(`ACP session ${sessionId} already has an active turn`);
    }

    const runtimeTurnId = `acp_turn_${crypto.randomUUID()}`;
    const activeTurn: ActiveACPTurn = {
      id: runtimeTurnId,
      turnId,
      canceled: false,
      settled: false,
    };
    session.activeTurn = activeTurn;

    void this.runPromptTurn(client, session, activeTurn, input);
    return { id: runtimeTurnId };
  }

  async steerTurn(
    _context: RuntimeContext,
    _sessionId: string,
    _runtimeTurnId: string,
    _input: string,
  ): Promise<void> {
    throw new Error(`ACP runtime (${this.profile.name}) does not support steering an active turn`);
  }

  async interruptTurn(
    context: RuntimeContext,
    sessionId: string,
    _runtimeTurnId: string,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.activeTurn) {
      session.activeTurn.canceled = true;
    }
    const client = await this.connect(context.project, Boolean(context.readOnly));
    await client.cancel(sessionId);
  }

  async compactSession(context: RuntimeContext, sessionId: string): Promise<void> {
    if (!this.profile.compactCommand) {
      throw new Error(`ACP runtime (${this.profile.name}) does not support session compaction`);
    }
    const session = this.requireSession(sessionId);
    session.context = context;
    if (session.activeTurn && !session.activeTurn.settled) {
      throw new Error("cannot compact while a turn is running");
    }

    const client = await this.connect(context.project, Boolean(context.readOnly));
    session.compacting = true;
    session.compactionReported = false;
    try {
      await client.prompt(sessionId, this.profile.compactCommand);
      if (!session.compactionReported) {
        await this.enqueueEvent(session, {
          type: "compaction.completed",
          sessionId,
          payload: {},
        });
      }
      await session.eventChain;
    } finally {
      session.compacting = false;
      session.compactionReported = false;
    }
  }

  async respondToApproval(
    _context: RuntimeContext,
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) {
      throw new Error(`no pending ACP approval request: ${requestId}`);
    }
    this.pendingApprovals.delete(requestId);
    pending.resolve(selectPermissionOption(pending.options, decision));
  }

  async releaseSession(_context: RuntimeContext, sessionId: string): Promise<void> {
    this.cancelApprovalsForSession(sessionId);
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.sessions.delete(sessionId);
    this.mcpBridge.unregisterSession(session.bridgeSessionId);
    session.normalizer.flush(sessionId);

    const client = this.client;
    if (client && client.agentCapabilities.sessionCapabilities?.close) {
      await client.closeSession(sessionId).catch((error) => {
        this.logger.warn("failed to close ACP session", { sessionId, error });
      });
    }
  }

  async stop(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.connecting = undefined;

    for (const [requestId, pending] of this.pendingApprovals) {
      this.pendingApprovals.delete(requestId);
      pending.resolve({ outcome: { outcome: "cancelled" } });
    }
    for (const session of this.sessions.values()) {
      this.mcpBridge.unregisterSession(session.bridgeSessionId);
    }
    this.sessions.clear();
    this.mcpBridge.stop();

    if (client) {
      this.logger.info("stopping ACP runtime", { runtime: this.profile.name });
      await client.close();
    }
  }

  private requireSession(sessionId: string): ManagedACPSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`ACP session not found: ${sessionId}`);
    }
    return session;
  }

  private async connect(project: ProjectConfig, readOnly: boolean): Promise<ACPClient> {
    if (this.client) return this.client;
    this.connecting ??= this.open(project, readOnly).finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async open(project: ProjectConfig, readOnly: boolean): Promise<ACPClient> {
    const { command, env } = this.profile.buildCommand({ project, readOnly });
    this.logger.info("starting ACP server", { runtime: this.profile.name, projectId: project.id });

    const client = ACPClient.spawn(
      command,
      { cwd: process.cwd(), env: { ...process.env, ...(env ?? {}) } },
      {
        onSessionUpdate: (notification) => this.handleSessionUpdate(notification),
        onRequestPermission: (request) => this.handlePermissionRequest(request),
        onExit: (expected) => this.handleExit(client, expected),
      },
      this.logger,
    );

    try {
      await client.initialize();
    } catch (error) {
      await client.close();
      throw error;
    }

    this.client = client;
    return client;
  }

  private handleExit(client: ACPClient, expected: boolean): void {
    if (this.client !== client) return;
    this.client = undefined;

    if (expected) {
      this.logger.info("ACP server stopped", { runtime: this.profile.name });
    } else {
      this.logger.error("ACP server exited unexpectedly", { runtime: this.profile.name });
    }

    for (const [requestId, pending] of this.pendingApprovals) {
      this.pendingApprovals.delete(requestId);
      pending.resolve({ outcome: { outcome: "cancelled" } });
    }

    const activeSessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of activeSessions) {
      this.mcpBridge.unregisterSession(session.bridgeSessionId);
      if (session.activeTurn) {
        session.activeTurn.settled = true;
      }
      if (!expected) {
        void this.enqueueEvent(session, {
          type: "runtime.disconnected",
          sessionId: session.sessionId,
          payload: { error: `ACP server (${this.profile.name}) exited` },
        });
      }
    }
  }

  private handleSessionUpdate(notification: SessionNotification): void {
    const session = this.sessions.get(notification.sessionId);
    if (!session) return;

    const update = notification.update;
    if (update.sessionUpdate === "usage_update") {
      if (typeof update.used === "number" && Number.isFinite(update.used)) {
        session.contextUsedTokens = update.used;
      }
      if (typeof update.size === "number" && Number.isFinite(update.size) && update.size > 0) {
        session.contextWindowTokens = update.size;
      }
    } else if (update.sessionUpdate === "config_option_update") {
      const updatedModel = extractACPActiveModel(update.configOptions);
      if (updatedModel) {
        session.activeModel = updatedModel;
      }
    }

    if (session.compacting) {
      if (update.sessionUpdate === "compaction_update" && update.status === "completed") {
        session.compactionReported = true;
        void this.enqueueEvent(session, {
          type: "compaction.completed",
          sessionId: session.sessionId,
          payload: {},
        });
      }
      return;
    }

    const turnId = session.activeTurn?.id;
    const events = session.normalizer.normalize(update, session.sessionId, turnId);
    for (const event of events) {
      if (event.type === "agent.message.completed" && session.activeTurn && event.payload.text) {
        session.activeTurn.finalText = event.payload.text;
      }
      void this.enqueueEvent(session, event);
    }
  }

  private async handlePermissionRequest(
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const session = this.sessions.get(request.sessionId);
    if (!session) {
      return { outcome: { outcome: "cancelled" } };
    }

    const toolName = request.toolCall.name ?? "";
    const normalizedActionName = toolName.startsWith(MCP_ORCHESTRATOR_PREFIX)
      ? toolName.slice(MCP_ORCHESTRATOR_PREFIX.length)
      : toolName;

    if (normalizedActionName && session.orchestratorTools.has(normalizedActionName)) {
      return selectPermissionOption(request.options, "approved");
    }

    if (session.context.readOnly) {
      const kind = request.toolCall.kind;
      if (kind && READ_ONLY_TOOL_KINDS.has(kind)) {
        return selectPermissionOption(request.options, "approved");
      }
      this.logger.warn("blocking non-read-only ACP tool call in readOnly mode", {
        sessionId: request.sessionId,
        toolName,
        kind,
      });
      return selectPermissionOption(request.options, "rejected");
    }

    const requestId = `acp_perm_${crypto.randomUUID()}`;
    const responsePromise = new Promise<RequestPermissionResponse>((resolve) => {
      this.pendingApprovals.set(requestId, {
        sessionId: request.sessionId,
        options: request.options,
        resolve,
      });
    });

    const rawInput =
      typeof request.toolCall.rawInput === "object" && request.toolCall.rawInput !== null
        ? (request.toolCall.rawInput as Record<string, unknown>)
        : {};

    void this.enqueueEvent(session, {
      type: "approval.requested",
      sessionId: request.sessionId,
      turnId: session.activeTurn?.id,
      payload: {
        requestId,
        actionType: mapActionType(request.toolCall.kind),
        description: request.toolCall.title ?? (toolName || "Approve tool execution"),
        payload: {
          toolCallId: request.toolCall.toolCallId,
          ...(toolName ? { toolName } : {}),
          ...(request.toolCall.kind ? { kind: request.toolCall.kind } : {}),
          ...rawInput,
        },
      },
    });

    return responsePromise;
  }

  private async runPromptTurn(
    client: ACPClient,
    session: ManagedACPSession,
    turn: ActiveACPTurn,
    input: string,
  ): Promise<void> {
    const startedAt = Date.now();
    try {
      const result = await client.prompt(session.sessionId, input);
      if (turn.settled) return;
      turn.settled = true;

      const openText = session.normalizer.currentMessageText();
      const flushed = session.normalizer.flush(session.sessionId, turn.id);
      for (const evt of flushed) {
        if (evt.type === "agent.message.completed" && evt.payload.text) {
          turn.finalText = evt.payload.text;
        }
        await this.enqueueEvent(session, evt);
      }

      const interrupted = turn.canceled || result.stopReason === "cancelled";
      const finalText = turn.finalText ?? (openText || undefined);
      const usage = normalizeACPPromptUsage(extractACPPromptUsage(result), {
        model: session.activeModel,
        provider: this.profile.name,
        contextUsedTokens: session.contextUsedTokens,
        contextWindowTokens: session.contextWindowTokens,
      });
      await this.enqueueEvent(session, {
        type: interrupted ? "turn.interrupted" : "turn.completed",
        sessionId: session.sessionId,
        turnId: turn.id,
        payload: {
          runtimeTurnId: turn.id,
          status: interrupted ? "interrupted" : "completed",
          durationMs: Date.now() - startedAt,
          ...(finalText !== undefined ? { finalText } : {}),
          ...(usage ? { usage } : {}),
        },
      });
    } catch (error) {
      if (turn.settled || !this.sessions.has(session.sessionId)) return;
      turn.settled = true;

      for (const evt of session.normalizer.flush(session.sessionId, turn.id)) {
        await this.enqueueEvent(session, evt);
      }

      const interrupted = turn.canceled;
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.enqueueEvent(session, {
        type: interrupted ? "turn.interrupted" : "turn.failed",
        sessionId: session.sessionId,
        turnId: turn.id,
        payload: {
          runtimeTurnId: turn.id,
          status: interrupted ? "interrupted" : "failed",
          durationMs: Date.now() - startedAt,
          ...(!interrupted ? { error: errorMessage } : {}),
        },
      });
    } finally {
      if (session.activeTurn === turn) {
        session.activeTurn = undefined;
      }
      this.cancelApprovalsForSession(session.sessionId);
    }
  }

  private async applySessionSettings(
    client: ACPClient,
    session: ManagedACPSession,
    context: RuntimeContext,
    configOptions: readonly SessionConfigOption[] | null | undefined,
  ): Promise<void> {
    const sessionId = session.sessionId;
    if (context.readOnly && this.profile.readOnlyModeId) {
      await client.setMode(sessionId, this.profile.readOnlyModeId).catch((error) => {
        this.logger.warn("failed to set ACP read-only mode", {
          sessionId,
          modeId: this.profile.readOnlyModeId,
          error,
        });
      });
    }

    if (!configOptions || configOptions.length === 0) return;

    const resolver = this.profile.resolveConfigUpdates ?? resolveStandardConfigUpdates;
    const updates = resolver({
      model: context.project.runtime?.model,
      reasoningEffort: context.project.runtime?.reasoningEffort,
      configOptions,
    });

    for (const update of updates) {
      try {
        const res = await client.setConfigOption(sessionId, update.configId, update.value);
        const updatedModel = extractACPActiveModel(res?.configOptions);
        if (updatedModel) {
          session.activeModel = updatedModel;
        }
      } catch (error) {
        this.logger.warn("failed to apply ACP session config option", {
          sessionId,
          configId: update.configId,
          value: update.value,
          error,
        });
      }
    }
  }

  private buildMcpServers(
    context: RuntimeContext,
    bridgeSessionId: string,
  ): { mcpServers: McpServer[]; orchestratorTools: Set<string> } {
    const projectServers = toACPMcpServers(context.project.runtime?.mcpServers ?? []);
    const bridgeServer = this.mcpBridge.mcpServerForSession(
      bridgeSessionId,
      context.taskKey,
      context.actionScope,
    );
    const mcpServers = bridgeServer ? [...projectServers, bridgeServer] : projectServers;
    const orchestratorTools = bridgeServer
      ? this.mcpBridge.toolNamesForScope(context.taskKey, context.actionScope)
      : new Set<string>();
    return { mcpServers, orchestratorTools };
  }

  private async resolveAdditionalDirectories(
    client: ACPClient,
    context: RuntimeContext,
  ): Promise<string[] | undefined> {
    if (!this.profile.injectSkillsViaAdditionalDirectories) return undefined;
    if (!client.agentCapabilities.sessionCapabilities?.additionalDirectories) return undefined;
    const dirs = await prepareACPSkillDirectories(
      this.dataDir,
      context.project,
      this.globalProject,
    );
    return dirs.length > 0 ? dirs : undefined;
  }

  private cancelApprovalsForSession(sessionId: string): void {
    for (const [requestId, pending] of this.pendingApprovals) {
      if (pending.sessionId !== sessionId) continue;
      this.pendingApprovals.delete(requestId);
      pending.resolve({ outcome: { outcome: "cancelled" } });
    }
  }

  private enqueueEvent(session: ManagedACPSession, event: RuntimeEvent): Promise<void> {
    session.eventChain = session.eventChain
      .then(() => session.context.onEvent(event))
      .catch((error) => {
        this.logger.error("failed to deliver ACP event", {
          sessionId: session.sessionId,
          type: event.type,
          error,
        });
      });
    return session.eventChain;
  }
}
