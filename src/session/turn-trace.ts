import type { TurnUsage } from "../domain/types.ts";
import { SpanStatusCode, startSpan, type Context, type Span } from "../observability/tracing.ts";
import type { RuntimeEvent } from "../runtime/runtime.ts";

export type TurnOutcome = "completed" | "failed" | "interrupted";

/**
 * The trace of one agent turn: an `invoke_agent` span with a child span for each tool call, MCP
 * call and shell command the agent runs, following the OpenTelemetry GenAI conventions.
 *
 * Command lines, tool arguments and outputs are not recorded, since they can hold credentials;
 * `runtime.item_id` points to the full record in the session's event log.
 */
export class TurnTrace {
  /** Parent context for work done on behalf of this turn, such as the actions it calls. */
  readonly context: Context;
  private readonly span: Span;
  /** Open child spans by the runtime's item ID. */
  private readonly items = new Map<string, Span>();
  private outputStarted = false;

  constructor(
    parent: Context,
    turn: {
      readonly projectId: string;
      readonly sessionId: string;
      readonly turnId: string;
      readonly source: string | undefined;
    },
  ) {
    const started = startSpan("invoke_agent", {
      parent,
      attributes: {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.conversation.id": turn.sessionId,
        "project.id": turn.projectId,
        "session.id": turn.sessionId,
        ...(turn.source ? { "session.source": turn.source } : {}),
        "turn.id": turn.turnId,
      },
    });
    this.span = started.span;
    this.context = started.context;
  }

  /** Called once the turn's session is bound to an agent runtime. */
  bindRuntime(runtime: string, model: string | undefined): void {
    this.span.updateName(`invoke_agent ${runtime}`);
    this.span.setAttributes({
      "agent.runtime": runtime,
      ...(model ? { "gen_ai.request.model": model } : {}),
    });
  }

  /** Turns one of the turn's runtime events into child spans. */
  record(event: RuntimeEvent): void {
    switch (event.type) {
      case "agent.message.delta":
        if (!this.outputStarted) {
          this.outputStarted = true;
          this.span.addEvent("first_output");
        }
        return;
      case "tool.call.started":
        this.open(event.payload.itemId, event.payload.toolName);
        return;
      case "tool.called":
        this.close(event.payload.itemId, toolFailure(event.payload));
        return;
      case "mcp_call.started": {
        const { itemId, serverName, toolName } = event.payload;
        this.open(itemId, `${serverName}.${toolName}`, {
          "mcp.server": serverName,
          "mcp.tool": toolName,
        });
        return;
      }
      case "mcp_call.completed":
        this.close(event.payload.itemId, toolFailure(event.payload));
        return;
      case "command.started":
        this.items.set(
          event.payload.itemId,
          startSpan("command", {
            parent: this.context,
            attributes: { "runtime.item_id": event.payload.itemId },
          }).span,
        );
        return;
      case "command.completed": {
        const { itemId, exitCode } = event.payload;
        this.items.get(itemId)?.setAttribute("process.exit.code", exitCode);
        this.close(itemId, exitCode === 0 ? undefined : `exit code ${exitCode}`);
        return;
      }
      default:
        return;
    }
  }

  finish(outcome: TurnOutcome, usage: TurnUsage | undefined, error: string | undefined): void {
    // Items the runtime never reported as finished, e.g. when the turn was interrupted.
    for (const span of this.items.values()) span.end();
    this.items.clear();

    this.span.setAttribute("turn.status", outcome);
    if (usage) {
      this.span.setAttributes({
        ...(usage.model ? { "gen_ai.response.model": usage.model } : {}),
        // The conventions count cached input tokens as part of the input.
        "gen_ai.usage.input_tokens":
          usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
        "gen_ai.usage.cache_read.input_tokens": usage.cacheReadTokens,
        "gen_ai.usage.cache_creation.input_tokens": usage.cacheWriteTokens,
        "gen_ai.usage.output_tokens": usage.outputTokens,
      });
    }
    if (outcome === "failed") {
      this.span.setStatus({ code: SpanStatusCode.ERROR, ...(error ? { message: error } : {}) });
    }
    this.span.end();
  }

  private open(itemId: string, toolName: string, attributes: Record<string, string> = {}): void {
    const { span } = startSpan(`execute_tool ${toolName}`, {
      parent: this.context,
      attributes: {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": toolName,
        "gen_ai.tool.call.id": itemId,
        "runtime.item_id": itemId,
        ...attributes,
      },
    });
    this.items.set(itemId, span);
  }

  private close(itemId: string, failure: string | undefined): void {
    const span = this.items.get(itemId);
    if (!span) return;
    this.items.delete(itemId);
    if (failure) span.setStatus({ code: SpanStatusCode.ERROR, message: failure });
    span.end();
  }
}

function toolFailure(payload: {
  readonly status: "success" | "failure";
  readonly error?: string | undefined;
}): string | undefined {
  return payload.status === "failure" ? (payload.error ?? "tool call failed") : undefined;
}
