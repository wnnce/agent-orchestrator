import {
  AGENT_METHODS,
  CLIENT_METHODS,
  PROTOCOL_VERSION,
  client,
  ndJsonStream,
  type AgentCapabilities,
  type ClientConnection,
  type InitializeResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type McpServer,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionNotification,
  type SetSessionConfigOptionResponse,
} from "@agentclientprotocol/sdk";
import type { FileSink, Subprocess } from "bun";
import type { Logger } from "../../observability/logger.ts";

const EXIT_GRACE_MS = 5_000;

export interface ACPClientHandlers {
  onSessionUpdate(notification: SessionNotification): void;
  onRequestPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  /** Called once when the underlying ACP subprocess exits. */
  onExit(expected: boolean): void;
}

function fileSinkToWritableStream(sink: FileSink): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    async write(chunk) {
      sink.write(chunk);
      await sink.flush();
    },
    async close() {
      await sink.end();
    },
    async abort() {
      await sink.end();
    },
  });
}

/**
 * Manages one spawned ACP server subprocess and its `@agentclientprotocol/sdk` client connection.
 */
export class ACPClient {
  private closing = false;
  private exitedHandled = false;
  private capabilities: AgentCapabilities = {};

  private constructor(
    private readonly proc: Subprocess<"pipe", "pipe", "inherit">,
    private readonly connection: ClientConnection,
    private readonly handlers: ACPClientHandlers,
    private readonly logger: Logger,
  ) {
    void this.watchExit();
  }

  static spawn(
    command: string[],
    options: { cwd: string; env: Record<string, string | undefined> },
    handlers: ACPClientHandlers,
    logger: Logger,
  ): ACPClient {
    const proc = Bun.spawn(command, {
      cwd: options.cwd,
      env: options.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    });

    const stream = ndJsonStream(fileSinkToWritableStream(proc.stdin), proc.stdout);
    const app = client({ name: "agent-orchestrator" })
      .onNotification(CLIENT_METHODS.session_update, ({ params }) => {
        handlers.onSessionUpdate(params);
      })
      .onRequest(CLIENT_METHODS.session_request_permission, ({ params }) =>
        handlers.onRequestPermission(params),
      );

    const connection = app.connect(stream);
    return new ACPClient(proc, connection, handlers, logger);
  }

  get agentCapabilities(): AgentCapabilities {
    return this.capabilities;
  }

  async initialize(): Promise<InitializeResponse> {
    const response = await this.connection.agent.request(AGENT_METHODS.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "agent-orchestrator", version: "0.1.0" },
    });
    this.capabilities = response.agentCapabilities ?? {};
    return response;
  }

  newSession(params: {
    cwd: string;
    mcpServers: McpServer[];
    additionalDirectories?: string[] | undefined;
  }): Promise<NewSessionResponse> {
    const request: NewSessionRequest = {
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      ...(params.additionalDirectories && params.additionalDirectories.length > 0
        ? { additionalDirectories: params.additionalDirectories }
        : {}),
    };
    return this.connection.agent.request(AGENT_METHODS.session_new, request);
  }

  resumeSession(params: {
    sessionId: string;
    cwd: string;
    mcpServers: McpServer[];
    additionalDirectories?: string[] | undefined;
  }): Promise<ResumeSessionResponse> {
    const request: ResumeSessionRequest = {
      sessionId: params.sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      ...(params.additionalDirectories && params.additionalDirectories.length > 0
        ? { additionalDirectories: params.additionalDirectories }
        : {}),
    };
    return this.connection.agent.request(AGENT_METHODS.session_resume, request);
  }

  loadSession(params: {
    sessionId: string;
    cwd: string;
    mcpServers: McpServer[];
    additionalDirectories?: string[] | undefined;
  }): Promise<LoadSessionResponse | void> {
    const request: LoadSessionRequest = {
      sessionId: params.sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      ...(params.additionalDirectories && params.additionalDirectories.length > 0
        ? { additionalDirectories: params.additionalDirectories }
        : {}),
    };
    return this.connection.agent.request(AGENT_METHODS.session_load, request);
  }

  setConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<SetSessionConfigOptionResponse> {
    return this.connection.agent.request(AGENT_METHODS.session_set_config_option, {
      sessionId,
      configId,
      value,
    });
  }

  setMode(sessionId: string, modeId: string): Promise<unknown> {
    return this.connection.agent.request(AGENT_METHODS.session_set_mode, {
      sessionId,
      modeId,
    });
  }

  prompt(sessionId: string, text: string): Promise<PromptResponse> {
    const request: PromptRequest = {
      sessionId,
      prompt: [{ type: "text", text }],
    };
    return this.connection.agent.request(AGENT_METHODS.session_prompt, request);
  }

  cancel(sessionId: string): Promise<void> {
    return this.connection.agent.notify(AGENT_METHODS.session_cancel, { sessionId });
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.connection.agent.request(AGENT_METHODS.session_close, { sessionId });
  }

  /** Stops the ACP connection and subprocess gracefully, escalating to SIGKILL on timeout. */
  async close(): Promise<void> {
    this.closing = true;
    this.connection.close();
    if (this.proc.exitCode === null && this.proc.signalCode === null) {
      this.proc.kill();
      const exited = await Promise.race([
        this.proc.exited.then(() => true),
        Bun.sleep(EXIT_GRACE_MS).then(() => false),
      ]);
      if (!exited) {
        this.proc.kill("SIGKILL");
        await this.proc.exited;
      }
    }
    this.notifyExit();
  }

  private async watchExit(): Promise<void> {
    try {
      await this.proc.exited;
    } catch (error) {
      this.logger.warn("ACP subprocess wait failed", { error });
    }
    this.connection.close();
    this.notifyExit();
  }

  private notifyExit(): void {
    if (this.exitedHandled) return;
    this.exitedHandled = true;
    this.handlers.onExit(this.closing);
  }
}
