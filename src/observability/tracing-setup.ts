import { context, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { detectResources, envDetector, resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  TracerProvider,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace";
import type { TracingConfig } from "../config/service.ts";
import type { Logger } from "./logger.ts";

const DEFAULT_SERVICE_NAME = "agent-orchestrator";

export interface TracingHandle {
  /** Exports the spans still buffered and unregisters the provider. */
  shutdown(): Promise<void>;
}

const DISABLED: TracingHandle = { shutdown: async () => {} };

/**
 * Registers the global tracer provider, context manager and W3C propagator. When tracing is
 * disabled nothing is registered, so the `@opentelemetry/api` calls in application code stay
 * no-ops.
 *
 * `spanProcessor` replaces the OTLP exporter, e.g. with an in-memory exporter in tests.
 */
export function setupTracing(
  config: TracingConfig | undefined,
  options: { readonly logger?: Logger | undefined; readonly spanProcessor?: SpanProcessor } = {},
): TracingHandle {
  if (!config?.enabled) return DISABLED;

  // Later sources win: built-in default, then OTEL_SERVICE_NAME / OTEL_RESOURCE_ATTRIBUTES,
  // then the service configuration.
  const resource = resourceFromAttributes({ "service.name": DEFAULT_SERVICE_NAME })
    .merge(detectResources({ detectors: [envDetector] }))
    .merge(
      resourceFromAttributes({
        ...(config.serviceName ? { "service.name": config.serviceName } : {}),
        ...(config.environment ? { "deployment.environment.name": config.environment } : {}),
      }),
    );
  const provider = new TracerProvider({
    resource,
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(config.sampleRate) }),
    spanProcessors: [options.spanProcessor ?? otlpProcessor(config)],
  });

  const contextManager = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(contextManager);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(provider);

  options.logger?.info("tracing enabled", {
    serviceName: resource.attributes["service.name"],
    sampleRate: config.sampleRate,
  });

  return {
    async shutdown() {
      try {
        await provider.shutdown();
      } finally {
        trace.disable();
        propagation.disable();
        context.disable();
      }
    },
  };
}

/** Endpoint and headers left out of the config are read by the exporter from `OTEL_*`. */
function otlpProcessor(config: TracingConfig): SpanProcessor {
  const exporter = new OTLPTraceExporter({
    ...(config.endpoint ? { url: config.endpoint } : {}),
    ...(Object.keys(config.headers).length > 0 ? { headers: config.headers } : {}),
  });
  return new BatchSpanProcessor({ exporter });
}
