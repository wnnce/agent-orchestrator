import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { CodexConfig } from "../config/service.ts";
import { Logger } from "../observability/logger.ts";
import type { McpServerConfig, ProjectConfig } from "../domain/types.ts";
import { SkillManager } from "../project/skills.ts";
import type {
  AgentRuntime,
  ApprovalDecision,
  RuntimeCapabilities,
  RuntimeContext,
  RuntimeSession,
  RuntimeTurn,
} from "./runtime.ts";
import { RuntimeSessionNotFoundError } from "./runtime.ts";
import { defaultActionRegistry, ActionRegistry, createActionContext } from "../actions/index.ts";
import { normalizeCodexNotification, notificationThreadId } from "./codex-normalizer.ts";
import { CodexConnection } from "./codex/connection.ts";
import type { RequestId } from "./codex/generated/RequestId.ts";
import type { ServerNotification } from "./codex/generated/ServerNotification.ts";
import type { ServerRequest } from "./codex/generated/ServerRequest.ts";
import type { DynamicToolCallParams } from "./codex/generated/v2/DynamicToolCallParams.ts";
import type { DynamicToolCallResponse } from "./codex/generated/v2/DynamicToolCallResponse.ts";
import type { ThreadStartResponse } from "./codex/generated/v2/ThreadStartResponse.ts";
import type { TurnStartResponse } from "./codex/generated/v2/TurnStartResponse.ts";

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
 * Recursively removes null and undefined properties so TOML serialization succeeds.
 */
export function cleanForToml(val: unknown): unknown {
  if (val === null || val === undefined) return undefined;
  if (Array.isArray(val)) {
    return val.map(cleanForToml).filter((v) => v !== undefined);
  }
  if (typeof val === "object") {
    const res: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      const cleaned = cleanForToml(v);
      if (cleaned !== undefined) res[k] = cleaned;
    }
    return res;
  }
  return val;
}

/**
 * Deeply merges two records. Source values override target values.
 * Nested objects are merged recursively.
 */
export function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof result[key] === "object" &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Parses a TOML string using Bun.TOML.
 */
export function parseToml(text: string): Record<string, unknown> {
  const bunToml = (Bun as unknown as { TOML?: { parse(text: string): unknown } }).TOML;
  if (typeof bunToml?.parse === "function") {
    try {
      return (bunToml.parse(text) ?? {}) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Serializes an object to TOML format using Bun.TOML.stringify.
 */
export function stringifyToml(obj: Record<string, unknown>): string {
  const cleaned = (cleanForToml(obj) ?? {}) as Record<string, unknown>;
  const bunToml = (Bun as unknown as { TOML?: { stringify(data: unknown): string } }).TOML;
  if (typeof bunToml?.stringify === "function") {
    return bunToml.stringify(cleaned);
  }
  return Object.entries(cleaned)
    .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
    .join("\n");
}

export class CodexRuntime implements AgentRuntime {
  readonly name = "codex";
  readonly type = "codex" as const;
  readonly capabilities: RuntimeCapabilities = CODEX_CAPABILITIES;
  private connection: CodexConnection | undefined;
  private connecting: Promise<CodexConnection> | undefined;
  /** Threads this process serves, by thread id. */
  private readonly contexts = new Map<string, RuntimeContext>();
  private readonly approvals = new Map<string, PendingApproval>();

  constructor(
    private readonly binary: string,
    private readonly logger = new Logger(),
    private readonly config: CodexConfig = {},
    private readonly inheritedSkillsProject?: ProjectConfig,
    private readonly actionRegistry: ActionRegistry = defaultActionRegistry,
  ) {}

  async startSession(context: RuntimeContext): Promise<RuntimeSession> {
    const connection = await this.connect(context.project);
    const result = await connection.request<ThreadStartResponse>(
      "thread/start",
      this.threadParams(context),
    );
    this.contexts.set(result.thread.id, context);
    return { id: result.thread.id, workspacePath: context.workspacePath };
  }

  async resumeSession(context: RuntimeContext, runtimeSessionId: string): Promise<RuntimeSession> {
    const connection = await this.connect(context.project);
    try {
      await connection.request("thread/resume", {
        threadId: runtimeSessionId,
        cwd: context.workspacePath,
        approvalPolicy: context.project.runtime?.approvalPolicy ?? "never",
        sandbox: context.project.runtime?.sandbox ?? "danger-full-access",
      });
    } catch (error) {
      // app-server reports an unknown thread only through its error message.
      if ((error as Error).message?.includes("no rollout found"))
        throw new RuntimeSessionNotFoundError(runtimeSessionId);
      throw error;
    }
    this.contexts.set(runtimeSessionId, context);
    return { id: runtimeSessionId, workspacePath: context.workspacePath };
  }

  async startTurn(
    context: RuntimeContext,
    sessionId: string,
    _turnId: string,
    input: string,
  ): Promise<RuntimeTurn> {
    const connection = await this.connect(context.project);
    const result = await connection.request<TurnStartResponse>("turn/start", {
      threadId: sessionId,
      input: [{ type: "text", text: input }],
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
    this.cancelApprovals(sessionId);
    await this.connection?.request("thread/unsubscribe", { threadId: sessionId });
  }

  async stop(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    this.contexts.clear();
    this.approvals.clear();
    if (connection) {
      this.logger.info("stopping Codex app-server");
      await connection.close();
    }
  }

  async listSkills(project?: ProjectConfig): Promise<unknown[]> {
    if (this.connection) {
      try {
        const res = await this.connection.request<{ data?: Array<{ skills?: unknown[] }> }>(
          "skills/list",
          {},
        );
        return (res.data ?? []).flatMap((entry) => entry.skills ?? []);
      } catch (error) {
        this.logger.warn("failed to list skills from Codex app-server", { error });
      }
    }
    return project ? SkillManager.listProjectSkills(project) : [];
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
    const codexHome = project.runtime?.codexHome ?? path.resolve(".data/codex", project.id);
    await this.ensureAuthAndConfig(codexHome, project);
    const env: Record<string, string | undefined> = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith("CODEX_") || key.startsWith("OPENAI_")) delete env[key];
    }
    env.CODEX_HOME = codexHome;
    const approvalPolicy = project.runtime?.approvalPolicy ?? "never";
    const sandboxMode = project.runtime?.sandbox ?? "danger-full-access";
    this.logger.info("starting Codex app-server", {
      projectId: project.id,
      codexHome,
      approvalPolicy,
      sandboxMode,
    });

    const connection: CodexConnection = CodexConnection.spawn(
      [
        this.binary,
        "app-server",
        "-c",
        `approval_policy=${JSON.stringify(approvalPolicy)}`,
        "-c",
        `sandbox_mode=${JSON.stringify(sandboxMode)}`,
      ],
      { cwd: codexHome, env },
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
      const skillsDir = SkillManager.getSkillsDir(project);
      if (skillsDir && existsSync(skillsDir)) {
        await connection.request("skills/extraRoots/set", { extraRoots: [skillsDir] });
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
    for (const event of normalizeCodexNotification(notification, threadId)) {
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
    const runtime = context.project.runtime;
    const params: Record<string, unknown> = {
      cwd: context.workspacePath,
      approvalPolicy: runtime?.approvalPolicy ?? "never",
      sandbox: runtime?.sandbox ?? "danger-full-access",
      serviceName: "agent-orchestrator",
    };
    if (runtime?.model) params.model = runtime.model;

    // Expose orchestrator actions as Codex dynamic tools (task and conversation scopes differ).
    const tools = this.actionRegistry.toCodexTools(context.taskKey ? "task" : "conversation");
    if (tools.length > 0) params.dynamicTools = tools;
    return params;
  }

  /** Runs an orchestrator action that Codex called as a dynamic tool and returns its result. */
  private async handleDynamicToolCall(
    connection: CodexConnection,
    requestId: RequestId,
    params: DynamicToolCallParams,
  ): Promise<void> {
    const context = this.contexts.get(params.threadId);
    const actionContext = context?.createActionContext
      ? context.createActionContext({ turnId: params.turnId })
      : createActionContext({
          projectId: context?.project.id ?? "unknown",
          sessionId: params.threadId,
          turnId: params.turnId,
          taskKey: context?.taskKey,
          workspacePath: context?.workspacePath ?? process.cwd(),
          logger: this.logger,
        });
    this.logger.info("running Codex dynamic tool call", {
      threadId: params.threadId,
      tool: params.tool,
    });

    const startedAt = Date.now();
    try {
      const result = await this.actionRegistry.execute(
        params.tool,
        params.arguments,
        actionContext,
      );
      const response: DynamicToolCallResponse = {
        success: result.success,
        contentItems: [
          {
            type: "inputText",
            text: JSON.stringify(result.success ? (result.data ?? {}) : { error: result.error }),
          },
        ],
      };
      connection.respond(requestId, response);
      await context?.onEvent({
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

  private async ensureAuthAndConfig(codexHome: string, project: ProjectConfig): Promise<void> {
    const apiKey = (
      this.config.apiKey ?? (this.config.auth as { apiKey?: string } | undefined)?.apiKey
    )?.trim();
    if (!apiKey) throw new Error("codex.apiKey must be configured in the service YAML");
    await mkdir(codexHome, { recursive: true, mode: 0o700 });

    // Replace managed credentials on every start, including stale imported state.
    const targetAuth = path.join(codexHome, "auth.json");
    await writeFile(
      targetAuth,
      JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: apiKey }, null, 2),
      { mode: 0o600 },
    );

    // 1. Start with base config if a base config file is specified
    let tomlData: Record<string, unknown> = {};
    const baseConfigPath =
      (project.runtime?.baseConfigPath as string | undefined) ??
      (this.config.baseConfigPath as string | undefined) ??
      (this.config.configPath as string | undefined);
    if (baseConfigPath) {
      const resolvedBase = path.resolve(baseConfigPath);
      if (existsSync(resolvedBase)) {
        const raw = await readFile(resolvedBase, "utf8");
        tomlData = parseToml(raw);
      }
    }

    // 2. Extract arbitrary runtime configurations from service YAML (runtimes.codex)
    const {
      apiKey: _apiKey,
      baseConfigPath: _basePath,
      configPath: _cfgPath,
      mcpServers: serviceMcpServers,
      config: serviceTomlConfig,
      auth: _auth,
      ...extraServiceConfig
    } = this.config;

    if (extraServiceConfig && Object.keys(extraServiceConfig).length > 0) {
      tomlData = deepMerge(tomlData, extraServiceConfig);
    }
    if (serviceTomlConfig && typeof serviceTomlConfig === "object") {
      tomlData = deepMerge(tomlData, serviceTomlConfig as Record<string, unknown>);
    }

    // 3. Merge project runtime configuration
    const {
      type: _type,
      codexHome: _home,
      approvalPolicy: projApproval,
      sandbox: projSandbox,
      model: projModel,
      reasoningEffort: projReasoning,
      mcpServers: projectMcpServers,
      config: projectTomlConfig,
      baseConfigPath: _projBase,
      ...extraProjectConfig
    } = (project.runtime ?? {}) as Record<string, unknown>;

    if (extraProjectConfig && Object.keys(extraProjectConfig).length > 0) {
      tomlData = deepMerge(tomlData, extraProjectConfig);
    }
    if (projectTomlConfig && typeof projectTomlConfig === "object") {
      tomlData = deepMerge(tomlData, projectTomlConfig as Record<string, unknown>);
    }

    // 4. Map model / reasoning effort if specified
    if (projModel && typeof projModel === "string") {
      tomlData.model = projModel;
    }
    if (projReasoning && typeof projReasoning === "string") {
      tomlData.model_reasoning_effort = projReasoning;
    }

    // 5. Enforced Orchestrator invariants (file store, approval policy, sandbox mode)
    tomlData.cli_auth_credentials_store = "file";
    tomlData.approval_policy =
      (projApproval as string) ?? (tomlData.approval_policy as string) ?? "never";
    tomlData.sandbox_mode =
      (projSandbox as string) ?? (tomlData.sandbox_mode as string) ?? "danger-full-access";

    // 7. Map MCP servers (from global service config and project config)
    const allMcpServers = [
      ...((serviceMcpServers ?? []) as McpServerConfig[]),
      ...((projectMcpServers ?? []) as McpServerConfig[]),
    ];
    if (allMcpServers.length > 0 || tomlData.mcp_servers) {
      const mcpTable = {
        ...((tomlData.mcp_servers ?? {}) as Record<string, unknown>),
      };
      for (const server of allMcpServers) {
        const serverConfig: Record<string, unknown> = {};
        if (server.url) serverConfig.url = server.url;
        if (server.command) {
          serverConfig.command = server.command;
          if (server.args) serverConfig.args = server.args;
        }
        if (server.auth) serverConfig.auth = server.auth;
        const httpHeaders = server.http_headers ?? server.headers;
        if (httpHeaders && Object.keys(httpHeaders).length > 0) {
          serverConfig.http_headers = httpHeaders;
        }
        if (server.required !== undefined) serverConfig.required = server.required;
        if (server.startupTimeoutSec !== undefined)
          serverConfig.startup_timeout_sec = server.startupTimeoutSec;
        if (server.toolTimeoutSec !== undefined)
          serverConfig.tool_timeout_sec = server.toolTimeoutSec;
        if (server.enabledTools) serverConfig.enabled_tools = server.enabledTools;
        if (server.disabledTools) serverConfig.disabled_tools = server.disabledTools;
        if (server.approvalMode) serverConfig.default_tools_approval_mode = server.approvalMode;
        mcpTable[server.name] = serverConfig;
      }
      tomlData.mcp_servers = mcpTable;
    }

    // 8. Write config.toml
    const targetConfig = path.join(codexHome, "config.toml");
    const tomlString = stringifyToml(tomlData);
    await writeFile(targetConfig, `# Generated by agent-orchestrator\n${tomlString}\n`, {
      mode: 0o600,
    });

    await SkillManager.syncSkillsToCodex(codexHome, project, this.inheritedSkillsProject);
  }
}
