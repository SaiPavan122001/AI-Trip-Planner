/**
 * A small metrics registry that renders the Prometheus text format.
 *
 * It is written here, rather than taken from a library, for one reason: the
 * rule that **no label may carry what a person wrote** is enforced by the
 * registry itself, not left to every call site.
 *
 *  - Every label is declared with the metric. A label with a closed set of
 *    values (`allowed`) maps anything else to `other`.
 *  - A label with an open but bounded set (a provider id, a route pattern) has
 *    a cap on how many distinct values it may take; the rest are `other`.
 *  - A value that does not look like an identifier (spaces, an `@`, more than
 *    80 characters, anything but letters, digits and `_ . : / { } -`) is
 *    `invalid`, whatever the metric: free text cannot become a label.
 *  - A metric may hold only so many series in total; past that, new series are
 *    dropped and counted (`telemetry_series_dropped_total`).
 *
 * So a bug that passes a message, an email address or a place name as a label
 * produces `invalid`/`other`, not a new time series per traveller.
 */

export type LabelValue = string | number | boolean | undefined;
export type Labels = Record<string, LabelValue>;

export interface LabelSpec {
  name: string;
  /** A closed set. Anything else is recorded as `other`. */
  allowed?: readonly string[];
  /** For an open set: how many distinct values before the rest become `other`. Default 50. */
  maxValues?: number;
}

const SAFE_VALUE = /^[A-Za-z0-9_.:/{}-]{1,80}$/;
const DEFAULT_MAX_VALUES = 50;
const MAX_SERIES = 1_000;

export const DEFAULT_BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120] as const;

abstract class Metric {
  protected readonly seenValues = new Map<string, Set<string>>();
  protected dropped = 0;

  constructor(
    readonly name: string,
    readonly help: string,
    readonly labels: readonly LabelSpec[],
    protected readonly onDrop: (metric: string) => void,
  ) {}

  /** The label values for these labels, in declaration order, made safe. */
  protected normalise(input: Labels): string[] {
    return this.labels.map((spec) => {
      const raw = input[spec.name];
      const value = raw === undefined ? 'none' : String(raw);
      if (spec.allowed) return spec.allowed.includes(value) ? value : 'other';
      if (!SAFE_VALUE.test(value)) return 'invalid';
      let seen = this.seenValues.get(spec.name);
      if (!seen) {
        seen = new Set();
        this.seenValues.set(spec.name, seen);
      }
      if (seen.has(value)) return value;
      if (seen.size >= (spec.maxValues ?? DEFAULT_MAX_VALUES)) return 'other';
      seen.add(value);
      return value;
    });
  }

  protected keyOf(values: string[]): string {
    return values.join('\u0001');
  }

  protected labelText(values: string[], extra?: string): string {
    const parts = this.labels.map((spec, i) => `${spec.name}="${escapeLabel(values[i]!)}"`);
    if (extra) parts.push(extra);
    return parts.length ? `{${parts.join(',')}}` : '';
  }

  abstract render(): string[];
  abstract reset(): void;
  abstract snapshot(): Array<{ labels: Record<string, string>; value: number; count?: number }>;

  protected asLabels(values: string[]): Record<string, string> {
    return Object.fromEntries(this.labels.map((spec, i) => [spec.name, values[i]!]));
  }
}

export class Counter extends Metric {
  private readonly series = new Map<string, { values: string[]; value: number }>();

  inc(labels: Labels = {}, by = 1): void {
    if (!(by >= 0) || !Number.isFinite(by)) return;
    const values = this.normalise(labels);
    const key = this.keyOf(values);
    let entry = this.series.get(key);
    if (!entry) {
      if (this.series.size >= MAX_SERIES) {
        this.onDrop(this.name);
        return;
      }
      entry = { values, value: 0 };
      this.series.set(key, entry);
    }
    entry.value += by;
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const { values, value } of sorted(this.series)) lines.push(`${this.name}${this.labelText(values)} ${value}`);
    return lines;
  }

  reset(): void {
    this.series.clear();
    this.seenValues.clear();
  }

  snapshot() {
    return [...this.series.values()].map((s) => ({ labels: this.asLabels(s.values), value: s.value }));
  }
}

export class Gauge extends Metric {
  private readonly series = new Map<string, { values: string[]; value: number }>();
  private collector: (() => Promise<Array<{ labels?: Labels; value: number }>>) | null = null;

  set(labels: Labels, value: number): void {
    const values = this.normalise(labels);
    const key = this.keyOf(values);
    if (!this.series.has(key) && this.series.size >= MAX_SERIES) return this.onDrop(this.name);
    this.series.set(key, { values, value });
  }

  /** A value read at scrape time (a queue depth), so it is never stale. */
  collectWith(read: () => Promise<Array<{ labels?: Labels; value: number }>>): void {
    this.collector = read;
  }

  async collect(): Promise<void> {
    if (!this.collector) return;
    try {
      const read = await this.collector();
      this.series.clear();
      for (const r of read) this.set(r.labels ?? {}, r.value);
    } catch {
      // A gauge that cannot be read is absent from this scrape, not a failed scrape.
      this.series.clear();
    }
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const { values, value } of sorted(this.series)) lines.push(`${this.name}${this.labelText(values)} ${value}`);
    return lines;
  }

  reset(): void {
    this.series.clear();
    this.seenValues.clear();
  }

  snapshot() {
    return [...this.series.values()].map((s) => ({ labels: this.asLabels(s.values), value: s.value }));
  }
}

export class Histogram extends Metric {
  private readonly series = new Map<string, { values: string[]; counts: number[]; sum: number; count: number }>();

  constructor(
    name: string,
    help: string,
    labels: readonly LabelSpec[],
    onDrop: (metric: string) => void,
    private readonly buckets: readonly number[] = DEFAULT_BUCKETS_SECONDS,
  ) {
    super(name, help, labels, onDrop);
  }

  observe(labels: Labels, value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    const values = this.normalise(labels);
    const key = this.keyOf(values);
    let entry = this.series.get(key);
    if (!entry) {
      if (this.series.size >= MAX_SERIES) return this.onDrop(this.name);
      entry = { values, counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.series.set(key, entry);
    }
    this.buckets.forEach((upper, i) => {
      if (value <= upper) entry.counts[i]! += 1;
    });
    entry.sum += value;
    entry.count += 1;
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const { values, counts, sum, count } of sorted(this.series)) {
      this.buckets.forEach((upper, i) => lines.push(`${this.name}_bucket${this.labelText(values, `le="${upper}"`)} ${counts[i]}`));
      lines.push(`${this.name}_bucket${this.labelText(values, 'le="+Inf"')} ${count}`);
      lines.push(`${this.name}_sum${this.labelText(values)} ${Number(sum.toFixed(6))}`);
      lines.push(`${this.name}_count${this.labelText(values)} ${count}`);
    }
    return lines;
  }

  reset(): void {
    this.series.clear();
    this.seenValues.clear();
  }

  snapshot() {
    return [...this.series.values()].map((s) => ({ labels: this.asLabels(s.values), value: s.sum, count: s.count }));
  }
}

function sorted<T extends { values: string[] }>(series: Map<string, T>): T[] {
  return [...series.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v);
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

export class MetricsRegistry {
  private readonly metrics: Metric[] = [];
  private readonly dropped: Counter;

  constructor() {
    this.dropped = this.counter('telemetry_series_dropped_total', 'Series not recorded because a metric hit its series ceiling.', [
      { name: 'metric', maxValues: 200 },
    ]);
  }

  private readonly drop = (metric: string) => this.dropped.inc({ metric });

  counter(name: string, help: string, labels: readonly LabelSpec[] = []): Counter {
    const metric = new Counter(name, help, labels, this.drop);
    this.metrics.push(metric);
    return metric;
  }

  gauge(name: string, help: string, labels: readonly LabelSpec[] = []): Gauge {
    const metric = new Gauge(name, help, labels, this.drop);
    this.metrics.push(metric);
    return metric;
  }

  histogram(name: string, help: string, labels: readonly LabelSpec[] = [], buckets?: readonly number[]): Histogram {
    const metric = new Histogram(name, help, labels, this.drop, buckets);
    this.metrics.push(metric);
    return metric;
  }

  /** The Prometheus text exposition of every metric that has a value. */
  async render(): Promise<string> {
    for (const m of this.metrics) if (m instanceof Gauge) await m.collect();
    const lines: string[] = [];
    for (const m of [...this.metrics].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const body = m.render();
      if (body.length > 2) lines.push(...body);
    }
    return `${lines.join('\n')}\n`;
  }

  /** Every metric's series as plain data, for tests and for the operator status view. */
  snapshot(): Record<string, Array<{ labels: Record<string, string>; value: number; count?: number }>> {
    return Object.fromEntries(this.metrics.map((m) => [m.name, m.snapshot()]));
  }

  /** The value of one series, or 0. For a histogram, its observation count. */
  value(name: string, labels: Record<string, string> = {}): number {
    const metric = this.metrics.find((m) => m.name === name);
    if (!metric) throw new Error(`No metric named ${name}.`);
    const wanted = Object.entries(labels);
    let total = 0;
    for (const s of metric.snapshot()) {
      if (wanted.every(([k, v]) => s.labels[k] === v)) total += s.count ?? s.value;
    }
    return total;
  }

  reset(): void {
    for (const m of this.metrics) m.reset();
  }
}
