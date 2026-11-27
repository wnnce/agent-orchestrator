import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ToolExecutionRecord } from "../domain/types.ts";
import { originRef } from "../domain/origin.ts";
import type { Logger } from "../observability/logger.ts";
import { sanitizeAuditPayload } from "./audit.ts";
import { type Context, SpanStatusCode, withSpan } from "../observability/tracing.ts";
import type { ToolCallResult, ToolContext, ToolDefinition, ToolSite, ToolSpec } from "./types.ts";

export interface ToolCallOptions {
  /** Replaces the tool's input schema for this session, e.g. a node-specific `pipeline_next`. */
  readonly input?: z.ZodObject | undefined;
  /** Trace the call belongs to: the turn that made it. */
  readonly traceContext?: Context | undefined;
}

/** The project's tools: which a session is offered, and running a call with audit and tracing. */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  constructor(
    tools: readonly ToolDefinition[],
    private readonly logger: Logger,
    private readonly audit?: (record: ToolExecutionRecord) => Promise<void>,
  ) {
    this.register(tools);
  }

  /**
   * Registers one or more tools. Throws on duplicate names unless `options.override` is true,
   * in which case the new definition replaces the existing one.
   */
  register(
    tools: ToolDefinition | readonly ToolDefinition[],
    options: { readonly override?: boolean | undefined } = {},
  ): void {
    const list: readonly ToolDefinition[] = Array.isArray(tools) ? tools : [tools];
    for (const tool of list) {
      if (this.tools.has(tool.name)) {
        if (!options.override) throw new Error(`duplicate tool: ${tool.name}`);
        this.logger.info("tool overridden", { tool: tool.name });
      }
      this.tools.set(tool.name, tool);
    }
  }

  /** All tools registered in this project, regardless of session `when` predicates. */
  all(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  /** The tools offered to a session at `site`. */
  list(site: ToolSite): ToolDefinition[] {
    return this.all().filter((tool) => tool.when?.(site) ?? true);
  }

  specs(site: ToolSite, inputs?: Readonly<Record<string, z.ZodObject>>): ToolSpec[] {
    return this.list(site).map((tool) => toSpec(tool, inputs?.[tool.name]));
  }

  async call(
    name: string,
    rawArgs: unknown,
    ctx: ToolContext,
    options: ToolCallOptions = {},
  ): Promise<ToolCallResult> {
    return withSpan(
      `tool ${name}`,
      {
        parent: options.traceContext,
        attributes: {
          "gen_ai.tool.name": name,
          "project.id": ctx.project.id,
          "session.id": ctx.session.id,
          ...(ctx.session.turnId ? { "turn.id": ctx.session.turnId } : {}),
        },
      },
      async (span) => {
        const result = await this.run(name, rawArgs, ctx, options);
        if (!result.ok) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            ...(result.error ? { message: result.error } : {}),
          });
        }
        return result;
      },
    );
  }

  private async run(
    name: string,
    rawArgs: unknown,
    ctx: ToolContext,
    options: ToolCallOptions,
  ): Promise<ToolCallResult> {
    const startedAt = Date.now();
    const tool = this.tools.get(name);
    const site: ToolSite = { owner: ctx.owner };
    if (!tool || !(tool.when?.(site) ?? true)) {
      return this.finish(name, rawArgs, ctx, startedAt, failure(`tool "${name}" is not available`));
    }

    let args: unknown = rawArgs ?? {};
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch (error) {
        return this.finish(
          name,
          rawArgs,
          ctx,
          startedAt,
          failure(`arguments of "${name}" are not valid JSON: ${message(error)}`),
        );
      }
    }
    const parsed = (options.input ?? tool.input).safeParse(args ?? {});
    if (!parsed.success) {
      return this.finish(
        name,
        args,
        ctx,
        startedAt,
        failure(`invalid arguments for "${name}": ${parsed.error.message}`),
      );
    }

    try {
      const data = await tool.run(parsed.data, ctx);
      return this.finish(name, parsed.data, ctx, startedAt, {
        ok: true,
        text: JSON.stringify(data ?? {}),
        data,
      });
    } catch (error) {
      return this.finish(name, parsed.data, ctx, startedAt, failure(message(error)));
    }
  }

  private async finish(
    name: string,
    args: unknown,
    ctx: ToolContext,
    startedAt: number,
    result: ToolCallResult,
  ): Promise<ToolCallResult> {
    if (!result.ok) {
      ctx.logger.warn("tool call failed", { tool: name, error: result.error });
    }
    if (!this.audit) return result;
    const owner = ctx.owner ? originRef(ctx.owner) : undefined;
    const record: ToolExecutionRecord = {
      executionId: `tex_${randomUUID()}`,
      projectId: ctx.project.id,
      sessionId: ctx.session.id,
      ...(ctx.session.turnId ? { turnId: ctx.session.turnId } : {}),
      ...(owner ? { ownerKind: owner.kind, ownerId: owner.id } : {}),
      toolName: name,
      parameters: auditPayload(args),
      status: result.ok ? "success" : "failure",
      ...(result.ok
        ? { result: sanitizeAuditPayload(result.data) }
        : { errorMessage: result.error }),
      durationMs: Date.now() - startedAt,
    };
    // The audit trail must not change the outcome the agent sees.
    await this.audit(record).catch((error) => {
      this.logger.warn("could not record tool execution", { tool: name, error: message(error) });
    });
    return result;
  }
}

function toSpec(tool: ToolDefinition, input?: z.ZodObject): ToolSpec {
  const schema = input ?? tool.input;
  return {
    name: tool.name,
    description: tool.description,
    input: schema,
    inputSchema: toJsonSchema(schema),
  };
}

export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...json } = z.toJSONSchema(schema) as Record<string, unknown>;
  return json;
}

function failure(error: string): ToolCallResult {
  return { ok: false, text: JSON.stringify({ error }), error };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function auditPayload(args: unknown): Record<string, unknown> {
  const value = sanitizeAuditPayload(args);
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { _value: value };
}
