import { Logger } from "../../observability/logger.ts";
import type { ProjectConfig } from "../../domain/types.ts";
import type {
  AgentRuntime,
  ApprovalDecision,
  RuntimeCapabilities,
  RuntimeContext,
  RuntimeSession,
  RuntimeTurn,
} from "../runtime.ts";
import { RuntimeSessionNotFoundError } from "../runtime.ts";
import { defaultActionRegistry, ActionRegistry } from "../../actions/index.ts";
import {
  actionContextFor,
  actionResultText,
  actionToJsonSchema,
  resolveActionsForSite,
} from "../action-bridge.ts";
import { normalizeCodexNotification, notificationThreadId } from "./normalizer.ts";
import { CodexUsageTracker } from "./usage.ts";
import { CodexConnection } from "./connection.ts";
import { codexMcpServers } from "./mcp.ts";
import { projectSkillSources } from "../skills.ts";
import type { RequestId } from "./generated/RequestId.ts";
import type { ServerNotification } from "./generated/ServerNotification.ts";
import type { ServerRequest } from "./generated/ServerRequest.ts";
import type { DynamicToolCallParams } from "./generated/v2/DynamicToolCallParams.ts";
import type { DynamicToolCallResponse } from "./generated/v2/DynamicToolCallResponse.ts";
import type { ThreadResumeResponse } from "./generated/v2/ThreadResumeResponse.ts";
import type { ThreadStartResponse } from "./generated/v2/ThreadStartResponse.ts";
import type { TurnStartResponse } from "./generated/v2/TurnStartResponse.ts";

/** JSON-RPC "method not found": the reply to server requests this service does not support. */
const METHOD_NOT_FOUND = -32601;

/** An approval Codex is waiting on; the response is sent when the user decides. */
interface PendingApproval {
  connection: CodexConnection;
  requestId: RequestId;
  threadId: string;
}

export const CODEX_CAPABILITIES: RuntimeCapabilities = {
  streaming: true,
  resume: true,
  steer: true,
  interrupt: true,
  compaction: true,
  approvals: true,
  mcp: true,
  structuredOutput: true,
  sandbox: true,
};

/**
 * Codex through `codex app-server`, one process per project. Codex reads its own configuration
 * (CODEX_HOME, by default ~/.codex): login, model provider, default model, approval policy,
 * sandbox and MCP servers. Each thread adds only what the project sets: model, reasoning effort,
 * MCP servers and, for a read-only session, the read-only sandbox.
 */
export class CodexRuntime implements AgentRuntime {
  readonly name = "codex";
  readonly type = "codex" as const;
  readonly capabilities: RuntimeCapabilities = CODEX_CAPABILITIES;
  private connection: CodexConnection | undefined;
  private connecting: Promise<CodexConnection> | undefined;
  /** Threads this process serves, by thread id. */
  private readonly contexts = new Map<string, RuntimeContext>();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly usageTracker = new CodexUsageTracker();

  constructor(
    private readonly binary: string,
    private readonly logger = new Logger(),
    private readonly globalProject?: ProjectConfig,
    private readonly actionRegistry: ActionRegistry = defaultActionRegistry,
  ) {}

  async startSession(context: RuntimeContext): Promise<RuntimeSession> {
    const connection = await this.connect(context.project);
    const result = await connection.request<ThreadStartResponse>(
      "thread/start",
      this.threadParams(context),
    );
    this.contexts.set(result.thread.id, context);
    this.usageTracker.initThread(result.thread.id, {
      model: result.model || context.project.runtime?.model,
      provider: result.modelProvider || undefined,
      resumed: false,
    });
    return { id: result.thread.id, workspacePath: context.workspacePath };
  }

  async resumeSession(context: RuntimeContext, runtimeSessionId: string): Promise<RuntimeSession> {
    const connection = await this.connect(context.project);
    let resumed: ThreadResumeResponse | undefined;
    try {
      resumed = await connection.request<ThreadResumeResponse>("thread/resume", {
        threadId: runtimeSessionId,
        ...this.threadOverrides(context),
      });
    } catch (error) {
      // app-server reports an unknown thread only through its error message.
      if ((error as Error).message?.includes("no rollout found"))
        throw new RuntimeSessionNotFoundError(runtimeSessionId);
      throw error;
    }
    this.contexts.set(runtimeSessionId, context);
    this.usageTracker.initThread(runtimeSessionId, {
      model: resumed?.model || context.project.runtime?.model,
      provider: resumed?.modelProvider || undefined,
      resumed: true,
    });
    return { id: runtimeSessionId, workspacePath: context.workspacePath };
  }

  async startTurn(
    context: RuntimeContext,
    sessionId: string,
    _turnId: string,
    input: string,
  ): Promise<RuntimeTurn> {
    const connection = await this.connect(context.project);
    this.usageTracker.onTurnStarted(sessionId);
    const effort = context.project.runtime?.reasoningEffort;
    const result = await connection.request<TurnStartResponse>("turn/start", {
      threadId: sessionId,
      input: [{ type: "text", text: input }],
      ...(effort ? { effort } : {}),
    });
    return { id: result.turn.id };
  }

  async steerTurn(
    context: RuntimeContext,
    sessionId: string,
    runtimeTurnId: string,
    input: string,
  ): Promise<void> {
    const connection = await this.connect(context.project);
    await connection.request("turn/steer", {
      threadId: sessionId,
      expectedTurnId: runtimeTurnId,
      input: [{ type: "text", text: input }],
    });
  }

  async interruptTurn(
    context: RuntimeContext,
    sessionId: string,
    runtimeTurnId: string,
  ): Promise<void> {
    const connection = await this.connect(context.project);
    await connection.request("turn/interrupt", { threadId: sessionId, turnId: runtimeTurnId });
  }

  async compactSession(context: RuntimeContext, sessionId: string): Promise<void> {
    const connection = await this.connect(context.project);
    await connection.request("thread/compact/start", { threadId: sessionId });
  }

  async respondToApproval(
    _context: RuntimeContext,
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    const approval = this.approvals.get(requestId);
    if (!approval) throw new Error(`no pending approval request: ${requestId}`);
    this.approvals.delete(requestId);
    approval.connection.respond(approval.requestId, {
      decision: decision === "approved" ? "accept" : "decline",
    });
  }

  async releaseSession(_context: RuntimeContext, sessionId: string): Promise<void> {
    if (!this.contexts.delete(sessionId)) return;
    this.usageTracker.deleteThread(sessionId);
    this.cancelApprovals(sessionId);
    await this.connection?.request("thread/unsubscribe", { threadId: sessionId });
  }

  async stop(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    this.contexts.clear();
    this.usageTracker.clear();
    this.approvals.clear();
    if (connection) {
      this.logger.info("stopping Codex app-server");
      await connection.close();
    }
  }

  /** Returns the running app-server, starting it on first use. Concurrent callers share a start. */
  private async connect(project: ProjectConfig): Promise<CodexConnection> {
    if (this.connection) return this.connection;
    this.connecting ??= this.open(project).finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  /** Starts app-server and completes the handshake; it becomes the current connection only then. */
  private async open(project: ProjectConfig): Promise<CodexConnection> {
    this.logger.info("starting Codex app-server", { projectId: project.id });
    const connection: CodexConnection = CodexConnection.spawn(
      [this.binary, "app-server"],
      { cwd: process.cwd(), env: process.env },
      {
        onNotification: (notification) => this.handleNotification(notification),
        onRequest: (request) => this.handleServerRequest(connection, request),
        onExit: (expected) => this.handleExit(connection, expected),
      },
      this.logger,
    );
    try {
      await connection.request("initialize", {
        clientInfo: { name: "agent-orchestrator", title: "Agent Orchestrator", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
      connection.notify("initialized", {});
      const extraRoots = projectSkillSources(project, this.globalProject).map((s) => s.dir);
      if (extraRoots.length > 0) {
        await connection.request("skills/extraRoots/set", { extraRoots });
      }
    } catch (error) {
      await connection.close();
      throw error;
    }
    this.connection = connection;
    return connection;
  }

  private handleExit(connection: CodexConnection, expected: boolean): void {
    if (this.connection !== connection) return;
    this.connection = undefined;
    if (expected) this.logger.info("Codex app-server stopped");
    else this.logger.error("Codex app-server exited unexpectedly");
    const contexts = [...this.contexts];
    this.contexts.clear();
    this.usageTracker.clear();
    this.approvals.clear();
    for (const [sessionId, context] of contexts) {
      void Promise.resolve(
        context.onEvent({
          type: "runtime.disconnected",
          sessionId,
          payload: { error: "Codex app-server exited" },
        }),
      ).catch((error) => this.logger.error("failed to report Codex disconnect", { error }));
    }
  }

  private handleNotification(notification: ServerNotification): void {
    const threadId = notificationThreadId(notification);
    const context = threadId ? this.contexts.get(threadId) : undefined;
    if (!threadId || !context) return;

    if (notification.method === "model/rerouted") {
      this.usageTracker.onModelRerouted(threadId, notification.params.toModel);
      return;
    }
    if (notification.method === "rawResponse/completed") {
      this.usageTracker.onRawResponseCompleted(threadId, notification.params.usage);
      return;
    }
    if (notification.method === "thread/tokenUsage/updated") {
      this.usageTracker.onThreadTokenUsageUpdated(threadId, notification.params.tokenUsage);
      return;
    }

    const turnUsage =
      notification.method === "turn/completed"
        ? this.usageTracker.consumeTurnUsage(threadId)
        : undefined;

    for (const event of normalizeCodexNotification(notification, threadId, turnUsage)) {
      void Promise.resolve(context.onEvent(event)).catch((error) =>
        this.logger.error("failed to deliver Codex event", { threadId, type: event.type, error }),
      );
    }
  }

  private handleServerRequest(connection: CodexConnection, request: ServerRequest): void {
    switch (request.method) {
      case "item/tool/call":
        void this.handleDynamicToolCall(connection, request.id, request.params);
        return;
      case "item/commandExecution/requestApproval":
        this.requestApproval(
          connection,
          request.id,
          request.params.threadId,
          request.params.turnId,
          {
            actionType: "command",
            description: request.params.reason ?? request.params.command ?? "Run a command",
            payload: request.params,
          },
        );
        return;
      case "item/fileChange/requestApproval":
        this.requestApproval(
          connection,
          request.id,
          request.params.threadId,
          request.params.turnId,
          {
            actionType: "file_change",
            description: request.params.reason ?? "Apply file changes",
            payload: request.params,
          },
        );
        return;
      default:
        // User input, MCP elicitation, permission grants, account and legacy requests.
        this.logger.warn("declining unsupported Codex server request", { method: request.method });
        connection.respondError(
          request.id,
          METHOD_NOT_FOUND,
          `${request.method} is not supported by agent-orchestrator`,
        );
    }
  }

  private requestApproval(
    connection: CodexConnection,
    requestId: RequestId,
    threadId: string,
    turnId: string,
    request: { actionType: "command" | "file_change"; description: string; payload: object },
  ): void {
    const context = this.contexts.get(threadId);
    if (!context) {
      this.logger.warn("declining Codex approval for a thread nobody is attached to", { threadId });
      connection.respond(requestId, { decision: "decline" });
      return;
    }
    const key = String(requestId);
    this.approvals.set(key, { connection, requestId, threadId });
    void Promise.resolve(
      context.onEvent({
        type: "approval.requested",
        sessionId: threadId,
        turnId,
        payload: {
          requestId: key,
          actionType: request.actionType,
          description: request.description,
          payload: { ...request.payload },
        },
      }),
    ).catch((error) => this.logger.error("failed to report Codex approval request", { error }));
  }

  /** Cancels approvals Codex is still waiting on for a thread that is being released. */
  private cancelApprovals(threadId: string): void {
    for (const [key, approval] of this.approvals) {
      if (approval.threadId !== threadId) continue;
      this.approvals.delete(key);
      approval.connection.respond(approval.requestId, { decision: "cancel" });
    }
  }

  private threadParams(context: RuntimeContext): Record<string, unknown> {
    const params: Record<string, unknown> = {
      ...this.threadOverrides(context),
      serviceName: "agent-orchestrator",
    };
    // Expose orchestrator actions as Codex dynamic tools (task, pipeline, and conversation scopes differ).
    const tools = resolveActionsForSite(this.actionRegistry, {
      taskKey: context.taskKey,
      actionScope: context.actionScope,
      actionParameterOverrides: context.actionParameterOverrides,
    }).map((action) => ({
      type: "function" as const,
      name: action.name,
      description: action.description,
      inputSchema: actionToJsonSchema(action.parameters),
    }));
    if (tools.length > 0) params.dynamicTools = tools;
    return params;
  }

  /** What a thread sets on top of Codex's own configuration, when it starts or resumes. */
  private threadOverrides(context: RuntimeContext): Record<string, unknown> {
    const runtime = context.project.runtime;
    const mcpServers = runtime?.mcpServers ?? [];
    return {
      cwd: context.workspacePath,
      ...(runtime?.model ? { model: runtime.model } : {}),
      ...(context.readOnly ? { sandbox: "read-only" } : {}),
      ...(mcpServers.length > 0 ? { config: { mcp_servers: codexMcpServers(mcpServers) } } : {}),
    };
  }

  /** Runs an orchestrator action that Codex called as a dynamic tool and returns its result. */
  private async handleDynamicToolCall(
    connection: CodexConnection,
    requestId: RequestId,
    params: DynamicToolCallParams,
  ): Promise<void> {
    const context = this.contexts.get(params.threadId);
    if (!context) {
      this.logger.warn("rejecting Codex tool call for a thread nobody is attached to", {
        threadId: params.threadId,
      });
      connection.respondError(requestId, -32602, `unknown thread ${params.threadId}`);
      return;
    }
    const actionContext = actionContextFor({
      project: context.project,
      workspacePath: context.workspacePath,
      sessionId: params.threadId,
      turnId: params.turnId,
      taskKey: context.taskKey,
      actionScope: context.actionScope,
      createActionContext: context.createActionContext,
      logger: this.logger,
    });
    this.logger.info("running Codex dynamic tool call", {
      threadId: params.threadId,
      tool: params.tool,
    });

    const startedAt = Date.now();
    try {
      await context.onEvent({
        type: "tool.call.started",
        sessionId: params.threadId,
        turnId: params.turnId,
        payload: {
          itemId: params.callId,
          toolName: params.tool,
          args: (params.arguments ?? {}) as Record<string, unknown>,
        },
      });
      const result = await this.actionRegistry.execute(
        params.tool,
        params.arguments,
        actionContext,
        { parameterOverride: context.actionParameterOverrides?.[params.tool] },
      );
      const response: DynamicToolCallResponse = {
        success: result.success,
        contentItems: [
          {
            type: "inputText",
            text: actionResultText(result),
          },
        ],
      };
      connection.respond(requestId, response);
      await context.onEvent({
        type: "tool.called",
        sessionId: params.threadId,
        turnId: params.turnId,
        payload: {
          itemId: params.callId,
          toolName: params.tool,
          args: (params.arguments ?? {}) as Record<string, unknown>,
          status: result.success ? "success" : "failure",
          result: result.data,
          error: result.error,
          durationMs: Date.now() - startedAt,
        },
      });
    } catch (error) {
      this.logger.error("Codex dynamic tool call failed", { tool: params.tool, error });
      try {
        connection.respond(requestId, {
          success: false,
          contentItems: [{ type: "inputText", text: String(error) }],
        } satisfies DynamicToolCallResponse);
      } catch {
        // The app-server is gone; its exit is reported separately.
      }
    }
  }
}
