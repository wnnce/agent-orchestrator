import {
  SpanKind,
  SpanStatusCode,
  context,
  propagation,
  type TextMapGetter,
} from "@opentelemetry/api";
import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import { activeTraceIds, withSpan } from "../observability/tracing.ts";

const headerGetter: TextMapGetter<Headers> = {
  get: (headers, key) => headers.get(key) ?? undefined,
  keys: (headers) => [...headers.keys()],
};

/**
 * One server span per request, continuing the caller's trace when it sends a `traceparent`.
 * The span is named after the matched route template so names stay few, and it ends when the
 * handler returns its response: a streaming response such as SSE does not keep it open.
 * `x-trace-id` lets a client report the trace of a failed request.
 */
export function httpTracing(): MiddlewareHandler {
  return async (c, next) => {
    const method = c.req.method;
    await withSpan(
      method,
      {
        parent: propagation.extract(context.active(), c.req.raw.headers, headerGetter),
        kind: SpanKind.SERVER,
        attributes: { "http.request.method": method, "url.path": c.req.path },
      },
      async (span) => {
        const traceIds = activeTraceIds();
        if (traceIds) c.header("x-trace-id", traceIds.traceId);
        await next();

        const route = routePath(c);
        span.updateName(`${method} ${route}`);
        span.setAttributes({ "http.route": route, "http.response.status_code": c.res.status });
        if (c.error) span.recordException(c.error);
        if (c.res.status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      },
    );
  };
}
