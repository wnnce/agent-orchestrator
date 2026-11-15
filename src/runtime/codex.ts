import { mkdir, writeFile, readdir, rm, symlink, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { CodexConfig } from "../config/service.ts";
import { Logger } from "../observability/logger.ts";
import type { ProjectConfig } from "../domain/types.ts";
import { SkillManager } from "../project/skills.ts";
import type {
  AgentRuntime,
  RuntimeCapabilities,
  RuntimeContext,
  RuntimeEvent,
  RuntimeSession,
  RuntimeTurn,
} from "./runtime.ts";
import {
  defaultActionRegistry,
  ActionRegistry,
  createActionContext,
  type ActionContext,
} from "../actions/index.ts";
import { normalizeCodexMessage } from "./codex-normalizer.ts";

interface RpcMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: any;
  error?: { message?: string };
}
const object = (value: unknown): Record<string, any> =>
  typeof value === "object" && value !== null ? (value as Record<string, any>) : {};

export class CodexRuntime implements AgentRuntime {
  readonly type = "codex" as const;
  readonly capabilities: RuntimeCapabilities = {
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
  private process: any;
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();
  private readonly contexts = new Map<string, RuntimeContext>();
  private started: Promise<void> | null = null;
  private stopping = false;
  constructor(
    private readonly binary: string,
    private readonly logger = new Logger(),
    private readonly config: CodexConfig = {},
    private readonly inheritedSkillsProject?: ProjectConfig,
    private readonly actionRegistry: ActionRegistry = defaultActionRegistry,
  ) {}

  private async ensureStarted(project: ProjectConfig): Promise<void> {
    if (this.started) return this.started;
    if (this.process) return;
    this.started = (async () => {
      this.stopping = false;
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
        binary: this.binary,
        codexHome,
        approvalPolicy,
        sandboxMode,
      });
      this.process = Bun.spawn(
        [
          this.binary,
          "app-server",
          "-c",
          `approval_policy=${JSON.stringify(approvalPolicy)}`,
          "-c",
          `sandbox_mode=${JSON.stringify(sandboxMode)}`,
        ],
        {
          cwd: codexHome,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "inherit",
          env,
        },
      );
      void this.readLoop(this.process.stdout as ReadableStream<Uint8Array>);
      await this.request("initialize", {
        clientInfo: { name: "agent-orchestrator", title: "Agent Orchestrator", version: "0.1.0" },
        capabilities: {
          mcpServerOpenaiFormElicitation: true,
          experimentalApi: true,
        },
      });
      this.write({ method: "initialized", params: {} });
      const skillsDir = SkillManager.getSkillsDir(project);
      if (skillsDir && existsSync(skillsDir)) {
        try {
          await this.request("skills/extraRoots/set", { extraRoots: [skillsDir] });
        } catch (error) {
          this.logger.debug("skills/extraRoots/set not supported or failed", { error });
        }
      }
    })().finally(() => {
      this.started = null;
    });
    return this.started;
  }

  private async ensureAuthAndConfig(codexHome: string, project: ProjectConfig): Promise<void> {
    const apiKey = this.config.apiKey?.trim();
    if (!apiKey) throw new Error("codex.apiKey must be configured in the service YAML");
    await mkdir(codexHome, { recursive: true, mode: 0o700 });

    // Replace managed credentials on every start, including stale imported state.
    const targetAuth = path.join(codexHome, "auth.json");
    await writeFile(
      targetAuth,
      JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: apiKey }, null, 2),
      { mode: 0o600 },
    );

    // Generate configuration exclusively from this service and project config.
    const targetConfig = path.join(codexHome, "config.toml");
    const approvalPolicy = project.runtime?.approvalPolicy ?? "never";
    const sandboxMode = project.runtime?.sandbox ?? "danger-full-access";
    const lines: string[] = [
      "# Generated by agent-orchestrator",
      'cli_auth_credentials_store = "file"',
      `approval_policy = ${JSON.stringify(approvalPolicy)}`,
      `sandbox_mode = ${JSON.stringify(sandboxMode)}`,
    ];

    const proxyUrl = this.config.baseUrl;
    if (proxyUrl) {
      lines.push("");
      lines.push('model_provider = "cliproxyapi"');
      lines.push("[model_providers.cliproxyapi]");
      lines.push('name = "cliproxyapi"');
      lines.push(`base_url = ${JSON.stringify(proxyUrl)}`);
      lines.push('wire_api = "responses"');
      lines.push("requires_openai_auth = true");
      lines.push("");
    }

    for (const server of project.runtime?.mcpServers ?? []) {
      lines.push(`[mcp_servers.${server.name}]`);
      if (server.url) lines.push(`url = ${JSON.stringify(server.url)}`);
      if (server.command) {
        lines.push(`command = ${JSON.stringify(server.command)}`);
        if (server.args) lines.push(`args = ${JSON.stringify(server.args)}`);
      }
      if (server.auth) lines.push(`auth = ${JSON.stringify(server.auth)}`);
      const httpHeaders = server.http_headers ?? server.headers;
      if (httpHeaders && Object.keys(httpHeaders).length > 0) {
        const entries = Object.entries(httpHeaders)
          .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
          .join(", ");
        lines.push(`http_headers = { ${entries} }`);
      }
      if (server.required !== undefined) lines.push(`required = ${server.required}`);
      if (server.startupTimeoutSec !== undefined)
        lines.push(`startup_timeout_sec = ${server.startupTimeoutSec}`);
      if (server.toolTimeoutSec !== undefined)
        lines.push(`tool_timeout_sec = ${server.toolTimeoutSec}`);
      if (server.enabledTools) lines.push(`enabled_tools = ${JSON.stringify(server.enabledTools)}`);
      if (server.disabledTools)
        lines.push(`disabled_tools = ${JSON.stringify(server.disabledTools)}`);
      if (server.approvalMode)
        lines.push(`default_tools_approval_mode = ${JSON.stringify(server.approvalMode)}`);
    }

    await writeFile(targetConfig, `${lines.join("\n")}\n`, { mode: 0o600 });
    await SkillManager.syncSkillsToCodex(codexHome, project, this.inheritedSkillsProject);
  }

  private async readLoop(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) {
          try {
            this.handle(JSON.parse(line) as RpcMessage);
          } catch {
            /* malformed output is represented by process failure */
          }
        }
        index = buffer.indexOf("\n");
      }
    }
    const error = new Error("Codex app-server exited");
    for (const [sessionId, context] of this.contexts) {
      await context.onEvent({
        type: "runtime.disconnected",
        sessionId,
        payload: { error: error.message },
      });
    }
    if (this.stopping) this.logger.info("Codex app-server stopped");
    else this.logger.error("Codex app-server exited", { error });
    for (const item of this.pending.values()) item.reject(error);
    this.pending.clear();
    this.process = undefined;
    this.contexts.clear();
  }

  private handle(message: RpcMessage): void {
    if (typeof message.id === "number" && (message.result !== undefined || message.error)) {
      const item = this.pending.get(message.id);
      if (!item) return;
      this.pending.delete(message.id);
      if (message.error) item.reject(new Error(message.error.message ?? "Codex request failed"));
      else item.resolve(message.result);
      return;
    }
    if (!message.method) return;
    const params = object(message.params);
    const sessionId =
      typeof params.threadId === "string"
        ? params.threadId
        : typeof object(params.thread).id === "string"
          ? object(params.thread).id
          : undefined;
    if (sessionId) {
      // Intercept native dynamic tool calls
      if (message.method === "item/tool/call" && typeof message.id === "number") {
        void this.handleDynamicToolCall(message.id, params, sessionId);
        return;
      }

      const context = this.contexts.get(sessionId);
      if (context) {
        if (typeof message.id === "number") params.requestId = String(message.id);
        void context.onEvent(
          this.toEvent(
            message.id === undefined ? message.method : "approval/requested",
            params,
            sessionId,
          ),
        );
      }
    }
  }

  private write(message: Record<string, unknown>): void {
    if (!this.process) throw new Error("Codex app-server is not running");
    const input = this.process.stdin as any;
    input.write(`${JSON.stringify(message)}\n`);
    if (typeof input.flush === "function") input.flush();
  }
  private async request(method: string, params: unknown): Promise<any> {
    const id = ++this.nextId;
    let timer: Timer;
    const result = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, 30_000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
    this.logger.debug("Codex JSON-RPC request", { method, requestId: id });
    try {
      this.write({ id, method, params });
    } catch (error) {
      this.pending.get(id)?.reject(error as Error);
      this.pending.delete(id);
    }
    return result;
  }
  private async call(
    context: RuntimeContext,
    method: string,
    params: Record<string, unknown>,
  ): Promise<any> {
    await this.ensureStarted(context.project);
    return this.request(method, params);
  }
  private toEvent(method: string, params: Record<string, any>, sessionId: string): RuntimeEvent {
    return normalizeCodexMessage(method, params, sessionId);
  }

  async startSession(context: RuntimeContext): Promise<RuntimeSession> {
    const result = object(await this.call(context, "thread/start", this.threadParams(context)));
    const thread = object(result.thread);
    if (typeof thread.id !== "string") throw new Error("Codex did not return a thread ID");
    this.contexts.set(thread.id, context);
    return { id: thread.id, workspacePath: context.workspacePath };
  }
  async resumeSession(context: RuntimeContext, runtimeSessionId: string): Promise<RuntimeSession> {
    if (this.contexts.has(runtimeSessionId)) {
      this.contexts.set(runtimeSessionId, context);
      return { id: runtimeSessionId, workspacePath: context.workspacePath };
    }
    try {
      await this.call(context, "thread/resume", {
        threadId: runtimeSessionId,
        cwd: context.workspacePath,
        approvalPolicy: context.project.runtime?.approvalPolicy ?? "never",
        sandbox: context.project.runtime?.sandbox ?? "danger-full-access",
      });
      this.contexts.set(runtimeSessionId, context);
      return { id: runtimeSessionId, workspacePath: context.workspacePath };
    } catch (err) {
      if ((err as Error).message?.includes("no rollout found")) {
        this.logger.warn("rollout not found for thread, starting new thread", { runtimeSessionId });
        return this.startSession(context);
      }
      throw err;
    }
  }
  async startTurn(
    context: RuntimeContext,
    sessionId: string,
    turnId: string,
    input: string,
  ): Promise<RuntimeTurn> {
    const result = object(
      await this.call(context, "turn/start", {
        threadId: sessionId,
        input: [{ type: "text", text: input }],
      }),
    );
    const turn = object(result.turn);
    const runtimeTurnId =
      typeof turn.id === "string"
        ? turn.id
        : typeof result.turnId === "string"
          ? result.turnId
          : turnId;
    return { id: runtimeTurnId };
  }
  async steerTurn(
    context: RuntimeContext,
    sessionId: string,
    runtimeTurnId: string,
    input: string,
  ): Promise<void> {
    await this.call(context, "turn/steer", {
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
    await this.call(context, "turn/interrupt", { threadId: sessionId, turnId: runtimeTurnId });
  }
  async compactSession(context: RuntimeContext, sessionId: string): Promise<void> {
    await this.call(context, "thread/compact/start", { threadId: sessionId });
  }
  async respondToApproval(
    context: RuntimeContext,
    requestId: string,
    result: unknown,
  ): Promise<void> {
    await this.ensureStarted(context.project);
    this.write({ id: Number(requestId), result });
  }
  async releaseSession(context: RuntimeContext, sessionId: string): Promise<void> {
    if (!this.process || !this.contexts.has(sessionId)) return;
    await this.call(context, "thread/unsubscribe", { threadId: sessionId });
    this.contexts.delete(sessionId);
  }
  async stop(): Promise<void> {
    if (this.process) {
      this.stopping = true;
      this.logger.info("stopping Codex app-server");
      this.process.kill();
      this.process = undefined;
    }
    this.contexts.clear();
    const error = new Error("Codex app-server stopped");
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
  async listSkills(project?: ProjectConfig): Promise<any[]> {
    if (this.process) {
      try {
        const res = await this.request("skills/list", {});
        if (res?.data && Array.isArray(res.data)) {
          return res.data.flatMap((entry: any) => entry.skills ?? []);
        }
        return Array.isArray(res) ? res : [];
      } catch (error) {
        this.logger.warn("failed to list skills from Codex app-server", { error });
      }
    }
    if (project) {
      return SkillManager.listProjectSkills(project);
    }
    return [];
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

    // Inject native Action definitions into Codex thread (task/conversation scope isolated)
    const scope = context.taskKey ? "task" : "conversation";
    const tools = this.actionRegistry.toCodexTools(scope);
    if (tools.length > 0) {
      params.dynamicTools = tools;
    }

    return params;
  }

  private async handleDynamicToolCall(
    requestId: number,
    params: Record<string, any>,
    sessionId?: string,
  ): Promise<void> {
    const toolName = typeof params.tool === "string" ? params.tool : "";
    const toolArgs = params.arguments;
    const context = sessionId ? this.contexts.get(sessionId) : undefined;

    const actionContext: ActionContext = context?.createActionContext
      ? context.createActionContext({
          turnId: typeof params.turnId === "string" ? params.turnId : undefined,
        })
      : createActionContext({
          projectId: context?.project.id ?? "unknown",
          sessionId: sessionId ?? "unknown",
          turnId: typeof params.turnId === "string" ? params.turnId : undefined,
          taskKey: context?.taskKey,
          workspacePath: context?.workspacePath ?? process.cwd(),
          logger: this.logger,
        });

    this.logger.info("handling dynamic tool call from Codex app-server", {
      requestId,
      toolName,
      sessionId,
      toolArgs,
    });

    const startTime = Date.now();
    const result = await this.actionRegistry.execute(toolName, toolArgs, actionContext);
    const durationMs = Math.max(0, Date.now() - startTime);

    // Return JSON-RPC response per Codex app-server specification
    const textOutput = JSON.stringify(result.success ? (result.data ?? {}) : { error: result.error });
    this.write({
      id: requestId,
      result: {
        success: result.success,
        contentItems: [
          {
            type: "inputText",
            text: textOutput,
          },
        ],
      },
    });

    // Emit runtime event for auditing and subscriber notification
    if (context && sessionId) {
      void context.onEvent({
        type: "tool.called",
        sessionId,
        turnId: typeof params.turnId === "string" ? params.turnId : undefined,
        payload: {
          itemId: `tool_${requestId}`,
          toolName,
          args: toolArgs,
          status: result.success ? "success" : "failure",
          result: result.data,
          error: result.error,
          durationMs,
          metadata: { requestId },
        },
      });
    }
  }
}
