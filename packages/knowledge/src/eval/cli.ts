import { compareVariants, STANDARD_VARIANTS } from './ab.js';
import { readBaseline, writeBaseline, BASELINE_PATH } from './baseline.js';
import { BASELINE_CONFIG } from './harness.js';
import { measureLatency } from './latency.js';
import { buildReport, compareReports } from './report.js';

/**
 * The evaluation command line (from packages/knowledge, after `npm run build`):
 *
 *   npm run eval                     run everything, compare with the committed baseline; exit 1 on a regression or a stale baseline
 *   npm run eval -- --write-baseline record this run as the baseline (review the diff, then commit it)
 *   npm run eval -- --ab             compare each standard variant with the baseline configuration
 *   npm run eval -- --latency        stage timings, token estimates and retrieval-call counts
 *   npm run eval -- --live           run the answer suite against the configured real model and embedder (opt-in; see docs/knowledge.md)
 *
 * The default run needs no network, no key and no database.
 */

const args = new Set(process.argv.slice(2));

async function main(): Promise<number> {
  if (args.has('--ab')) {
    const rows: Array<Record<string, unknown>> = [];
    for (const variant of STANDARD_VARIANTS) {
      const c = await compareVariants(BASELINE_CONFIG, variant);
      rows.push({ variant: variant.name, ...c.delta, gains: c.bOnly.join(' '), losses: c.aOnly.join(' ') });
    }
    console.table(rows);
    return 0;
  }
  if (args.has('--latency')) {
    console.log(JSON.stringify(await measureLatency(), null, 2));
    return 0;
  }
  if (args.has('--live')) {
    const { runLive } = await import('./live.js');
    return runLive();
  }

  const report = await buildReport();
  if (args.has('--write-baseline')) {
    writeBaseline(report);
    console.log(`Baseline written to ${BASELINE_PATH}`);
    return 0;
  }
  console.table(Object.entries(report.metrics).map(([metric, value]) => ({ metric, value, better: report.directions[metric] })));
  const baseline = readBaseline();
  if (!baseline) {
    console.error('No baseline recorded. Run with --write-baseline.');
    return 1;
  }
  const diff = compareReports(baseline, report);
  if (diff.identical) {
    console.log('Identical to the baseline.');
    return 0;
  }
  if (diff.regressions.length) console.error('REGRESSIONS:', diff.regressions);
  if (diff.improvements.length) console.log('Improvements (record with --write-baseline):', diff.improvements);
  if (diff.changed.length) console.log('Changed configuration:', diff.changed);
  if (diff.behaviourChanged) console.log('The pipeline answers differently from the baseline.');
  return diff.regressions.length > 0 || diff.changed.length > 0 || diff.behaviourChanged ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  },
);
