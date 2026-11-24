import type {
  CanUseTool,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "../../observability/logger.ts";
import type { ApprovalDecision, RuntimeContext, RuntimeEvent } from "../runtime.ts";
import { RuntimeSessionNotFoundError } from "../runtime.ts";
import { ClaudeNormalizer, toolKind } from "./normalizer.ts";
import { ClaudeUsageTracker } from "./usage.ts";

/** The parts of the SDK's Query a session uses; tests substitute a scripted one. */
export type ClaudeQuery = AsyncIterable<SDKMessage> &
  Pick<Query, "initializationResult" | "interrupt" | "close">;

export type ClaudeQueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => ClaudeQuery;

interface ActiveTurn {
  turnId: string;
  runtimeTurnId: string;
  /** Inputs (the prompt and any steers) that have not been answered by a `result` yet. */
  pending: string[];
  canceled: boolean;
  lastText?: string | undefined;
}

interface PendingApproval {
  input: Record<string, unknown>;
  resolve: (result: PermissionResult) => void;
}

export interface ClaudeSessionParams {
  id: string;
  resume: boolean;
  context: RuntimeContext;
  logger: Logger;
  query: ClaudeQueryFn;
  /** Builds the query options; the session supplies its own permission callback. */
  options: (canUseTool: CanUseTool) => Options;
  /** Called when the Claude Code process goes away without being released. */
  onExit: (session: ClaudeSession) => void;
}

/**
 * One orchestrator session backed by one long-lived Claude Code query in streaming-input mode.
 *
 * Every input carries a client uuid and every `result` lists the inputs it answered
 * (`user_message_uuids`), so a turn ends once its prompt and all steers have been answered —
 * whether Claude Code folded a steer into the turn or ran it as a follow-up.
 */
export class ClaudeSession {
  readonly id: string;
  context: RuntimeContext;

  private readonly input = new InputQueue();
  private readonly normalizer: ClaudeNormalizer;
  private readonly usageTracker: ClaudeUsageTracker;
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly query: ClaudeQuery;
  private turn: ActiveTurn | undefined;
  private compaction: { uuid: string; done: (error?: Error) => void } | undefined;
  private ready = false;
  private closed = false;
  /** A `result` before initialization finished: how a failed resume shows up. */
  private startupError: string | undefined;
  private loop: Promise<void> | undefined;

  constructor(private readonly params: ClaudeSessionParams) {
    this.id = params.id;
    this.context = params.context;
    this.normalizer = new ClaudeNormalizer(params.id, params.context.workspacePath);
    this.usageTracker = new ClaudeUsageTracker(params.resume);
    this.query = params.query({
      prompt: this.input,
      options: params.options((toolName, input, options) =>
        this.requestApproval(toolName, input, options.toolUseID, options.signal, options.title),
      ),
    });
  }

  /** Waits until Claude Code is ready; a resume of a session it does not have is reported. */
  async open(): Promise<void> {
    const initialized = this.query.initializationResult();
    this.loop = this.consume();
    try {
      await initialized;
      this.ready = true;
    } catch (error) {
      this.close();
      await this.loop;
      if (this.params.resume && this.startupError) {
        this.params.logger.warn("claude code could not resume session", {
          sessionId: this.id,
          error: this.startupError,
        });
        throw new RuntimeSessionNotFoundError(this.id);
      }
      throw new Error(`Claude Code failed to start: ${this.startupError ?? errorMessage(error)}`);
    }
  }

  startTurn(turnId: string, text: string): string {
    if (this.turn) throw new Error(`Claude session ${this.id} already has a running turn`);
    const runtimeTurnId = `claude_turn_${crypto.randomUUID()}`;
    const uuid = crypto.randomUUID();
    this.turn = { turnId, runtimeTurnId, pending: [uuid], canceled: false };
    this.input.push(userMessage(text, uuid));
    return runtimeTurnId;
  }

  steer(text: string): void {
    if (!this.turn || this.turn.canceled) throw new Error("no active turn");
    const uuid = crypto.randomUUID();
    this.turn.pending.push(uuid);
    this.input.push(userMessage(text, uuid, "now"));
  }

  async interrupt(): Promise<void> {
    if (!this.turn) return;
    this.turn.canceled = true;
    await this.query.interrupt();
  }

  /** Runs `/compact`, Claude Code's own compaction command, and waits for it to finish. */
  async compact(): Promise<void> {
    if (this.turn) throw new Error("cannot compact while a turn is running");
    if (this.compaction) throw new Error("compaction already in progress");
    const uuid = crypto.randomUUID();
    const done = new Promise<void>((resolve, reject) => {
      this.compaction = { uuid, done: (error) => (error ? reject(error) : resolve()) };
    });
    this.input.push(userMessage("/compact", uuid));
    await done;
  }

  hasApproval(requestId: string): boolean {
    return this.approvals.has(requestId);
  }

  respondToApproval(requestId: string, decision: ApprovalDecision): void {
    const approval = this.approvals.get(requestId);
    if (!approval) throw new Error(`no pending approval request: ${requestId}`);
    this.settleApproval(
      requestId,
      decision === "approved"
        ? { behavior: "allow", updatedInput: approval.input }
        : { behavior: "deny", message: "The user rejected this action." },
    );
  }

  /** Ends the Claude Code process. Pending approvals are rejected so nothing waits forever. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const id of [...this.approvals.keys()]) {
      this.settleApproval(id, { behavior: "deny", message: "The session was closed." });
    }
    this.compaction?.done(new Error("session closed"));
    this.compaction = undefined;
    this.input.close();
    this.query.close();
  }

  private requestApproval(
    toolName: string,
    input: Record<string, unknown>,
    requestId: string,
    signal: AbortSignal,
    title: string | undefined,
  ): Promise<PermissionResult> {
    const kind = toolKind(toolName).kind;
    // The orchestrator's own actions never need the user's approval.
    if (kind === "action") return Promise.resolve({ behavior: "allow", updatedInput: input });
    return new Promise<PermissionResult>((resolve) => {
      this.approvals.set(requestId, { input, resolve });
      signal.addEventListener("abort", () =>
        this.settleApproval(requestId, { behavior: "deny", message: "The turn was interrupted." }),
      );
      void this.emit({
        type: "approval.requested",
        sessionId: this.id,
        turnId: this.turn?.turnId,
        payload: {
          requestId,
          actionType:
            kind === "command" ? "command" : kind === "file_change" ? "file_change" : "tool_call",
          description: title ?? toolName,
          payload: { toolName, input },
        },
      });
    });
  }

  private settleApproval(requestId: string, result: PermissionResult): void {
    const approval = this.approvals.get(requestId);
    if (!approval) return;
    this.approvals.delete(requestId);
    approval.resolve(result);
  }

  private async consume(): Promise<void> {
    let failure: unknown;
    try {
      for await (const message of this.query) await this.handle(message);
    } catch (error) {
      failure = error;
    }
    if (this.closed || !this.ready) return;
    // The process went away while the session was still in use.
    this.params.logger.error("claude code session exited unexpectedly", {
      sessionId: this.id,
      error: failure === undefined ? "stream ended" : errorMessage(failure),
    });
    this.close();
    this.params.onExit(this);
    await this.emit({
      type: "runtime.disconnected",
      sessionId: this.id,
      payload: { error: "Claude Code exited" },
    });
  }

  private async handle(message: SDKMessage): Promise<void> {
    if (message.type === "result") {
      if (!this.ready) this.startupError = resultError(message);
      else await this.handleResult(message);
      return;
    }
    if (message.type === "system" && message.subtype === "init") {
      this.usageTracker.onSystemInit(message.model);
      this.params.logger.debug("claude code session initialized", {
        sessionId: this.id,
        model: message.model,
        tools: message.tools.length,
        mcpServers: message.mcp_servers.map((server) => `${server.name}:${server.status}`),
      });
    }
    if (message.type === "assistant") {
      this.usageTracker.onAssistantMessage(message);
    }
    const turn = this.turn;
    for (const event of this.normalizer.normalize(message, turn?.turnId)) {
      if (turn && event.type === "agent.message.completed" && event.payload.text) {
        turn.lastText = event.payload.text;
      }
      await this.emit(event);
    }
  }

  private async handleResult(result: SDKResultMessage): Promise<void> {
    const answered = result.user_message_uuids ?? [];
    const turn = this.turn;
    if (turn && (answered.length === 0 || answered.some((id) => turn.pending.includes(id)))) {
      this.usageTracker.recordResult(result);
      // Results from older CLIs carry no uuids; they answer the oldest input.
      turn.pending =
        answered.length === 0
          ? turn.pending.slice(1)
          : turn.pending.filter((id) => !answered.includes(id));
      if (turn.canceled || turn.pending.length === 0) await this.finishTurn(turn, result);
      return;
    }
    const compaction = this.compaction;
    if (!turn && compaction && (answered.length === 0 || answered.includes(compaction.uuid))) {
      this.usageTracker.syncBaseline(result);
      this.compaction = undefined;
      const error = resultError(result);
      compaction.done(error ? new Error(error) : undefined);
      return;
    }
    this.usageTracker.syncBaseline(result);
    this.params.logger.debug("ignoring claude code result for an earlier input", {
      sessionId: this.id,
    });
  }

  private async finishTurn(turn: ActiveTurn, result: SDKResultMessage): Promise<void> {
    this.turn = undefined;
    this.normalizer.endTurn();
    const usage = this.usageTracker.consumeTurnUsage();
    this.params.logger.debug("claude code turn finished", {
      sessionId: this.id,
      turnId: turn.turnId,
      subtype: result.subtype,
      durationMs: result.duration_ms,
      numTurns: result.num_turns,
      costUsd: result.total_cost_usd,
    });
    const base = {
      turnId: turn.turnId,
      runtimeTurnId: turn.runtimeTurnId,
      ...(usage ? { usage } : {}),
    };
    const error = resultError(result);
    if (turn.canceled) {
      await this.emit({
        type: "turn.interrupted",
        sessionId: this.id,
        turnId: turn.turnId,
        payload: { ...base, status: "interrupted" },
      });
    } else if (error) {
      await this.emit({
        type: "turn.failed",
        sessionId: this.id,
        turnId: turn.turnId,
        payload: { ...base, status: "failed", error },
      });
    } else {
      const finalText = (result.subtype === "success" && result.result) || turn.lastText;
      await this.emit({
        type: "turn.completed",
        sessionId: this.id,
        turnId: turn.turnId,
        payload: { ...base, status: "completed", finalText, durationMs: result.duration_ms },
      });
    }
  }

  private async emit(event: RuntimeEvent): Promise<void> {
    try {
      await this.context.onEvent(event);
    } catch (error) {
      this.params.logger.error("failed to dispatch claude code event", {
        sessionId: this.id,
        type: event.type,
        error: errorMessage(error),
      });
    }
  }
}

/** A failed result's error text; undefined for a successful one. "success" can still be an error. */
function resultError(result: SDKResultMessage): string | undefined {
  if (result.subtype !== "success") return result.errors.join("\n") || result.subtype;
  return result.is_error ? result.result || "Claude Code reported an error" : undefined;
}

function userMessage(text: string, uuid: string, priority?: "now"): SDKUserMessage {
  return {
    type: "user",
    uuid: uuid as SDKUserMessage["uuid"] & string,
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    ...(priority ? { priority } : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The session's input stream: messages pushed while the query reads them one at a time. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly items: SDKUserMessage[] = [];
  private waiting: ((result: IteratorResult<SDKUserMessage>) => void) | undefined;
  private closed = false;

  push(message: SDKUserMessage): void {
    if (this.closed) throw new Error("Claude session is closed");
    const waiting = this.waiting;
    this.waiting = undefined;
    if (waiting) waiting({ value: message, done: false });
    else this.items.push(message);
  }

  close(): void {
    this.closed = true;
    this.waiting?.({ value: undefined, done: true });
    this.waiting = undefined;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}
