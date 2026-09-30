import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { EvalReport } from './report.js';

/** The committed baseline: the report a run is compared with. Lives beside the code, in packages/knowledge/eval/. */
export const BASELINE_PATH = fileURLToPath(new URL('../../eval/baseline.json', import.meta.url));

export function readBaseline(): EvalReport | null {
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as EvalReport;
  } catch {
    return null;
  }
}

export function writeBaseline(report: EvalReport): void {
  writeFileSync(BASELINE_PATH, `${JSON.stringify(report, null, 2)}\n`);
}
