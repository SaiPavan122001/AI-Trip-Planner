import { activeTraceIds, categoryOfError, metrics, withSpan } from '@trip/telemetry';
import type { Logger } from 'pino';
import type { Store } from '../repository/store.js';

/**
 * Times every store operation, without touching either store.
 *
 * The store is wrapped in a proxy that looks each method up at the moment it is
 * called (so a test that replaces a method on the underlying store still sees
 * its replacement), measures how long the call takes, and reports:
 *
 *  - a histogram by operation name (`getSession`, `claimRun`, ...): a bounded,
 *    fixed set of names, never an argument;
 *  - a span (`db.operation`) under whatever request or run is active (and none
 *    when nothing is: housekeeping and heartbeats outside any request would each
 *    be a trace of one);
 *  - a counter and one warning line for an operation slower than `slowMs`,
 *    carrying the operation and how long it took and nothing else.
 *
 * The arguments (a trip, an email, a token hash) are never recorded. That is
 * the whole point of doing it here: no call site can leak one. Every method of
 * the `Store` interface is asynchronous, so every wrapped call is too.
 */
const PASS_THROUGH = new Set(['constructor', 'toString', 'toJSON', 'valueOf']);

export function instrumentStore(store: Store, options: { slowMs: number; logger: Logger }): Store {
  // The proxy's own target is an empty object, and every lookup goes to the real store. A proxy over the
  // store itself must return a frozen property's exact value (a JavaScript rule), which would stop a test
  // from replacing a method with a stand-in.
  const target = store;
  return new Proxy({} as Store, {
    get(_empty, property) {
      const value = Reflect.get(target, property) as unknown;
      if (typeof value !== 'function' || typeof property !== 'string' || PASS_THROUGH.has(property)) return value;
      const operation = property;
      return (...args: unknown[]) => {
        const measured = async () => {
          const started = performance.now();
          try {
            const answer = await (value as (...a: unknown[]) => unknown).apply(target, args);
            record(operation, started, 'ok');
            return answer;
          } catch (err) {
            record(operation, started, 'error');
            metrics.errors.inc({ category: categoryOfError(err), component: 'database' });
            throw err;
          }
        };
        return activeTraceIds() ? withSpan('db.operation', { 'db.operation': operation }, measured, { kind: 'client' }) : measured();
      };
    },
  });

  function record(operation: string, started: number, outcome: 'ok' | 'error'): void {
    const ms = performance.now() - started;
    metrics.dbDuration.observe({ operation, outcome }, ms / 1000);
    if (ms >= options.slowMs) {
      metrics.dbSlow.inc({ operation });
      options.logger.warn({ operation: 'db.slow', dbOperation: operation, durationMs: Math.round(ms), outcome }, 'A store operation was slow');
    }
  }
}
