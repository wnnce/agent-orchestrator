import {
  ROOT_CONTEXT,
  SpanStatusCode,
  context,
  isSpanContextValid,
  propagation,
  trace,
  type Attributes,
  type Context,
  type Link,
  type Span,
  type SpanKind,
  type SpanOptions as ApiSpanOptions,
  type Tracer,
} from "@opentelemetry/api";

/**
 * Tracing helpers for application code. They only use `@opentelemetry/api`: until
 * `setupTracing` registers a provider, every span is a no-op and nothing is recorded.
 */

const TRACER_NAME = "agent-orchestrator";

/**
 * Looked up on every use rather than cached, so the tracer always belongs to the provider
 * registered at the time (tests register and remove providers repeatedly).
 */
export function tracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

export interface SpanOptions {
  readonly attributes?: Attributes | undefined;
  /** The context to continue; defaults to the active one. */
  readonly parent?: Context | undefined;
  /** Starts a new trace instead of continuing the parent. */
  readonly root?: boolean | undefined;
  readonly links?: Link[] | undefined;
  readonly kind?: SpanKind | undefined;
}

function toApiOptions(options: SpanOptions): ApiSpanOptions {
  return {
    ...(options.attributes ? { attributes: options.attributes } : {}),
    ...(options.root ? { root: true } : {}),
    ...(options.links ? { links: options.links } : {}),
    ...(options.kind !== undefined ? { kind: options.kind } : {}),
  };
}

/** Runs `fn` inside a new active span that records a thrown error and always ends. */
export function withSpan<T>(
  name: string,
  options: SpanOptions,
  fn: (span: Span) => Promise<T> | T,
): Promise<T> {
  return tracer().startActiveSpan(
    name,
    toApiOptions(options),
    options.parent ?? context.active(),
    async (span) => {
      try {
        return await fn(span);
      } catch (error) {
        markSpanFailed(span, error);
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

/**
 * Starts a span whose lifetime is not one call, e.g. one driven by events; the caller ends it.
 * The returned context makes it the parent of spans started under it.
 */
export function startSpan(
  name: string,
  options: SpanOptions,
): { readonly span: Span; readonly context: Context } {
  const parent = options.parent ?? context.active();
  const span = tracer().startSpan(name, toApiOptions(options), parent);
  return { span, context: trace.setSpan(parent, span) };
}

export function markSpanFailed(span: Span, error: unknown): void {
  const err = error instanceof Error ? error : new Error(String(error));
  span.recordException(err);
  span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
}

/** The active context, to hand to work that runs later, e.g. a queued turn or task. */
export function captureTraceContext(): Context {
  return context.active();
}

/** Runs `fn` with `traceContext` as the active context. */
export function withTraceContext<T>(traceContext: Context, fn: () => T): T {
  return context.with(traceContext, fn);
}

/**
 * Runs background work, such as a queue pump, outside the trace of whatever request started it.
 * Each unit of work then names its parent explicitly instead of inheriting a stale one.
 */
export function detached<T>(fn: () => T): T {
  return context.with(ROOT_CONTEXT, fn);
}

/** The active span as a W3C `traceparent`, for storing next to a persistent record. */
export function activeTraceparent(): string | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent;
}

/** Links to the span a stored `traceparent` names; empty when it is missing or malformed. */
export function linksTo(traceparent: string | undefined): Link[] {
  if (!traceparent) return [];
  const spanContext = trace.getSpanContext(propagation.extract(ROOT_CONTEXT, { traceparent }));
  return spanContext && isSpanContextValid(spanContext) ? [{ context: spanContext }] : [];
}

/** IDs of the active span, for correlating log lines with traces. */
export function activeTraceIds():
  { readonly traceId: string; readonly spanId: string } | undefined {
  const spanContext = trace.getActiveSpan()?.spanContext();
  if (!spanContext || !isSpanContextValid(spanContext)) return undefined;
  return { traceId: spanContext.traceId, spanId: spanContext.spanId };
}

export { SpanKind, SpanStatusCode, type Context, type Span } from "@opentelemetry/api";
