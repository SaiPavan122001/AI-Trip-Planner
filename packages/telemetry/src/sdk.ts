import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  InMemorySpanExporter,
  ParentBasedSampler,
  SimpleSpanProcessor,
  TraceIdRatioBasedSampler,
  type ReadableSpan,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';

/**
 * Installs the tracing SDK for a process (the API, a worker, a test).
 *
 * With nothing else configured, spans are created and carry valid trace and
 * span identifiers (so logs can be correlated with them) but are not sent
 * anywhere. Set `OTEL_EXPORTER_OTLP_ENDPOINT` and they are exported over OTLP
 * (HTTP) to whatever collector that names; the exporter is loaded only then.
 * A test passes an in-memory exporter and reads the finished spans back.
 *
 * Sampling is parent-based: a request that arrives already sampled (or not) keeps
 * that decision; a new trace is sampled at `sampleRatio`. An unsampled span still
 * has identifiers, so logs stay correlated when traces are thinned out.
 */

export interface TracingOptions {
  serviceName: string;
  environment: string;
  /** 0 to 1. Default 1 (every trace). */
  sampleRatio?: number;
  /** An OTLP/HTTP traces endpoint, e.g. `http://collector:4318/v1/traces`. */
  otlpEndpoint?: string;
  /** For tests: exports through this, synchronously. */
  exporter?: SpanExporter;
}

export interface TracingHandle {
  /** Flushes and stops exporting. */
  shutdown(): Promise<void>;
}

let installed: BasicTracerProvider | null = null;

export async function setupTracing(options: TracingOptions): Promise<TracingHandle> {
  await resetTracing();
  const processors: SpanProcessor[] = [];
  if (options.exporter) processors.push(new SimpleSpanProcessor(options.exporter));
  else if (options.otlpEndpoint) {
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
    processors.push(new BatchSpanProcessor(new OTLPTraceExporter({ url: options.otlpEndpoint })));
  }
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ 'service.name': options.serviceName, 'deployment.environment.name': options.environment }),
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(options.sampleRatio ?? 1) }),
    spanProcessors: processors,
  });
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(provider);
  installed = provider;
  return {
    shutdown: async () => {
      if (installed === provider) await resetTracing();
      else await provider.shutdown();
    },
  };
}

/** True once `setupTracing` has installed an SDK in this process. */
export function isTracingInstalled(): boolean {
  return installed !== null;
}

/** Removes the installed SDK (flushing it). For shutdown, and for tests that install their own. */
export async function resetTracing(): Promise<void> {
  const provider = installed;
  installed = null;
  trace.disable();
  context.disable();
  if (provider) await provider.shutdown().catch(() => undefined);
}

/** An exporter that keeps finished spans in memory: what tests read. */
export function memorySpanExporter(): InMemorySpanExporter {
  return new InMemorySpanExporter();
}

export type { ReadableSpan, SpanExporter };
