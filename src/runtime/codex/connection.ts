import type { Subprocess } from "bun";
import type { Logger } from "../../observability/logger.ts";
import type { RequestId } from "./generated/RequestId.ts";
import type { ServerNotification } from "./generated/ServerNotification.ts";
import type { ServerRequest } from "./generated/ServerRequest.ts";

const REQUEST_TIMEOUT_MS = 30_000;
const EXIT_GRACE_MS = 5_000;

export interface CodexConnectionHandlers {
  onNotification(notification: ServerNotification): void;
  onRequest(request: ServerRequest): void;
  /** Called once when the process exits; `expected` is true after `close()`. */
  onExit(expected: boolean): void;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: Timer;
}

interface RpcMessage {
  id?: RequestId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

/**
 * One `codex app-server` process and its JSON-RPC (JSON lines over stdio) channel.
 * All state belongs to the process, so a restarted server never sees a previous one's requests.
 */
export class CodexConnection {
  private nextId = 0;
  private readonly pending = new Map<RequestId, PendingRequest>();
  private closing = false;

  private constructor(
    private readonly proc: Subprocess<"pipe", "pipe", "inherit">,
    private readonly handlers: CodexConnectionHandlers,
    private readonly logger: Logger,
  ) {
    void this.readLoop();
  }

  static spawn(
    command: string[],
    options: { cwd: string; env: Record<string, string | undefined> },
    handlers: CodexConnectionHandlers,
    logger: Logger,
  ): CodexConnection {
    const proc = Bun.spawn(command, {
      cwd: options.cwd,
      env: options.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    });
    return new CodexConnection(proc, handlers, logger);
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.logger.debug("codex request", { method, requestId: id });
      try {
        this.write({ id, method, params });
      } catch (error) {
        this.settle(id)?.reject(error as Error);
      }
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  respond(id: RequestId, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: RequestId, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  /** Stops the process and waits for it to exit (forcefully after a grace period). */
  async close(): Promise<void> {
    this.closing = true;
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

  private write(message: RpcMessage): void {
    if (this.proc.exitCode !== null || this.proc.signalCode !== null)
      throw new Error("Codex app-server is not running");
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
    this.proc.stdin.flush();
  }

  private settle(id: RequestId): PendingRequest | undefined {
    const request = this.pending.get(id);
    if (!request) return undefined;
    this.pending.delete(id);
    clearTimeout(request.timer);
    return request;
  }

  private async readLoop(): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of this.proc.stdout) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) this.dispatch(line);
          newline = buffer.indexOf("\n");
        }
      }
    } catch (error) {
      this.logger.warn("codex app-server output stream failed", { error });
    }
    const error = new Error("Codex app-server exited");
    for (const id of [...this.pending.keys()]) this.settle(id)?.reject(error);
    this.handlers.onExit(this.closing);
  }

  private dispatch(line: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      this.logger.warn("ignoring malformed codex app-server output", { line: line.slice(0, 200) });
      return;
    }
    try {
      if (message.method === undefined) {
        // A response to one of our requests.
        if (message.id === undefined) return;
        const request = this.settle(message.id);
        if (!request) return;
        if (message.error)
          request.reject(new Error(message.error.message ?? `Codex ${request.method} failed`));
        else request.resolve(message.result);
      } else if (message.id !== undefined) {
        this.handlers.onRequest(message as ServerRequest);
      } else {
        this.handlers.onNotification(message as ServerNotification);
      }
    } catch (error) {
      this.logger.error("failed to handle codex app-server message", {
        method: message.method,
        error,
      });
    }
  }
}
