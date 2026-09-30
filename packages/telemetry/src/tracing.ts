import {
  SpanKind,
  SpanStatusCode,
  context,
  trace,
  type Attributes,
  type Context,
  type Span,
} from '@opentelemetry/api';
import { categoryOfError } from './errors.js';
import { currentCorrelation, type Correlation } from './context.js';

/**
 * Tracing, in the OpenTelemetry model (`@opentelemetry/api`): a trace is the
 * story of one request; a span is one step in it, with a start, an end, a
 * status and attributes. Libraries here create spans through `withSpan`;
 * nothing is recorded unless an SDK is installed (`setupTracing` in `sdk.ts`,
 * called by the API), which keeps the packages usable and testable without it.
 *
 * **What a span may carry** is a policy, enforced in `safeAttributes`:
 *
 *  - only strings, numbers and booleans, each string cut to 200 characters;
 *  - never an attribute whose name says it is a prompt, a body, a message, a
 *    cookie, a token, a secret, an email, a password, or the like;
 *  - never an exception's *message* (messages quote input); a failed span
 *    carries `error.type` (the class) and `error.category` (see `errors.ts`).
 *
 * A model call's span carries the model, the task, the token counts and the
 * outcome, and never the prompt or the answer.
 */

const TRACER = 'trip-planner';

/** Attribute names that are never recorded, whatever their value. */
const FORBIDDEN = /prompt|body|message|utterance|cookie|token|secret|password|passwd|authorization|api[_-]?key|email|credential|answer|free_?text/i;
const MAX_STRING = 200;

export type SpanAttributes = Record<string, string | number | boolean | undefined | null>;

export function safeAttributes(attributes: SpanAttributes | undefined): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (value === undefined || value === null) continue;
    if (FORBIDDEN.test(key)) continue;
    if (typeof value === 'string') out[key] = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean') out[key] = value;
  }
  return out;
}

export interface SpanOptions {
  kind?: 'internal' | 'server' | 'client' | 'producer' | 'consumer';
  /** Continue a trace begun elsewhere (a request that queued this work), as a W3C `traceparent`. */
  parentTraceparent?: string | undefined;
}

const KIND: Record<NonNullable<SpanOptions['kind']>, SpanKind> = {
  internal: SpanKind.INTERNAL,
  server: SpanKind.SERVER,
  client: SpanKind.CLIENT,
  producer: SpanKind.PRODUCER,
  consumer: SpanKind.CONSUMER,
};

/**
 * Runs `work` inside a new span, which is ended however it finishes. A throw
 * marks the span as failed (class and category only) and is rethrown
 * unchanged.
 */
export async function withSpan<T>(
  name: string,
  attributes: SpanAttributes,
  work: (span: Span) => Promise<T> | T,
  options: SpanOptions = {},
): Promise<T> {
  const tracer = trace.getTracer(TRACER);
  const parent = options.parentTraceparent ? contextFromTraceparent(options.parentTraceparent) : context.active();
  const span = tracer.startSpan(name, { kind: KIND[options.kind ?? 'internal'], attributes: safeAttributes({ ...correlationAttributes(), ...attributes }) }, parent);
  try {
    return await context.with(trace.setSpan(parent, span), () => work(span));
  } catch (err) {
    recordFailure(span, err);
    throw err;
  } finally {
    span.end();
  }
}

export interface ManualSpan {
  span: Span;
  /** Runs `fn` with this span active, so everything it starts is a child of it. */
  activate<T>(fn: () => T): T;
  /** Ends the span, with the HTTP-style outcome given. */
  end(outcome?: { failed?: boolean; category?: string; attributes?: SpanAttributes }): void;
}

/**
 * A span whose start and end are in different callbacks, as an HTTP server's
 * request hooks are. Use `withSpan` wherever one function can hold the span.
 */
export function startManualSpan(name: string, attributes: SpanAttributes, options: SpanOptions = {}): ManualSpan {
  const tracer = trace.getTracer(TRACER);
  const parent = options.parentTraceparent ? contextFromTraceparent(options.parentTraceparent) : context.active();
  const span = tracer.startSpan(name, { kind: KIND[options.kind ?? 'internal'], attributes: safeAttributes({ ...correlationAttributes(), ...attributes }) }, parent);
  const active = trace.setSpan(parent, span);
  let ended = false;
  return {
    span,
    activate: (fn) => context.with(active, fn),
    end: (outcome = {}) => {
      if (ended) return;
      ended = true;
      if (outcome.attributes) span.setAttributes(safeAttributes(outcome.attributes));
      if (outcome.category) span.setAttribute('error.category', outcome.category);
      if (outcome.failed) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
    },
  };
}

/** Marks a span failed without recording the error's message. */
export function recordFailure(span: Span, err: unknown): void {
  const category = categoryOfError(err);
  span.setAttribute('error.type', err instanceof Error ? err.name : typeof err);
  span.setAttribute('error.category', category);
  span.setStatus({ code: category === 'cancelled' ? SpanStatusCode.UNSET : SpanStatusCode.ERROR });
}

/** Marks a span failed by category, for a failure that was returned rather than thrown. */
export function markSpanError(span: Span, category: string, local = false): void {
  span.setAttribute('error.category', category);
  span.setStatus({ code: local ? SpanStatusCode.UNSET : SpanStatusCode.ERROR });
}

/** Adds a named event (a retry, a fallback, a circuit skip) to the active span, if there is one. */
export function addSpanEvent(name: string, attributes: SpanAttributes = {}): void {
  trace.getActiveSpan()?.addEvent(name, safeAttributes(attributes));
}

/** Sets attributes on the active span, if there is one. */
export function setSpanAttributes(attributes: SpanAttributes): void {
  trace.getActiveSpan()?.setAttributes(safeAttributes(attributes));
}

export interface TraceIds {
  traceId: string;
  spanId: string;
}

/** The active span's identifiers, or null when nothing is being traced. */
export function activeTraceIds(): TraceIds | null {
  const ctx = trace.getActiveSpan()?.spanContext();
  if (!ctx || !trace.isSpanContextValid(ctx)) return null;
  return { traceId: ctx.traceId, spanId: ctx.spanId };
}

/** The active span as a W3C `traceparent`, for storing with work that will run later. */
export function activeTraceparent(): string | null {
  const ctx = trace.getActiveSpan()?.spanContext();
  if (!ctx || !trace.isSpanContextValid(ctx)) return null;
  return `00-${ctx.traceId}-${ctx.spanId}-${(ctx.traceFlags & 1) === 1 ? '01' : '00'}`;
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/** A `traceparent` if it is well formed and not the all-zero placeholder; otherwise undefined. */
export function validTraceparent(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const m = TRACEPARENT.exec(value);
  if (!m || /^0+$/.test(m[1]!) || /^0+$/.test(m[2]!)) return undefined;
  return value;
}

function contextFromTraceparent(traceparent: string): Context {
  const valid = validTraceparent(traceparent);
  if (!valid) return context.active();
  const [, , traceId, spanId, flags] = /^(00)-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(valid)!;
  return trace.setSpanContext(context.active(), {
    traceId: traceId!,
    spanId: spanId!,
    traceFlags: Number.parseInt(flags!, 16) & 1,
    isRemote: true,
  });
}

function correlationAttributes(): SpanAttributes {
  const c: Correlation = currentCorrelation();
  return { 'trip.request_id': c.requestId, 'trip.run_id': c.runId, 'trip.trip_id': c.tripId };
}

/**
 * The fields every log line carries so it can be found from a trace and the
 * reverse: the correlation identifiers and the active trace and span.
 */
export function correlationFields(): Record<string, string> {
  const c = currentCorrelation();
  const ids = activeTraceIds();
  return {
    ...(c.requestId ? { requestId: c.requestId } : {}),
    ...(c.runId ? { runId: c.runId } : {}),
    ...(c.tripId ? { tripId: c.tripId } : {}),
    ...(ids ? { traceId: ids.traceId, spanId: ids.spanId } : {}),
  };
}
