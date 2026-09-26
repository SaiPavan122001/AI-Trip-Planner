'use client';

import type { FeasibilityReport } from '@/lib/api';

/**
 * Whether the trip can be done as asked. It says which requirement, budget or
 * missing source stands in the way, with the numbers, and what could be
 * relaxed. Nothing is changed for the traveller; this only explains.
 */
export function FeasibilityPanel({ report, hasPlans }: { report: FeasibilityReport | null; hasPlans: boolean }) {
  const findings = (report?.findings ?? []).filter((f) => f.severity !== 'info');
  if (!report || findings.length === 0) return null;

  const heading = !hasPlans
    ? 'This trip could not be planned as asked'
    : report.status === 'partial'
      ? 'Some of what you asked for could not be met'
      : 'Worth knowing about this trip';

  return (
    <section className="card border-l-4 border-clay/60 p-5" aria-live="polite">
      <h2 className="font-display text-xl tracking-tight">{heading}</h2>
      <p className="mt-1 text-sm text-ink-soft">
        Nothing has been loosened for you. Here is what stands in the way, and what you could change.
      </p>
      <ul className="mt-4 space-y-4">
        {findings.map((f) => (
          <li key={f.code}>
            <p className={`text-sm ${f.severity === 'blocker' ? 'font-semibold text-clay' : 'text-ink'}`}>{f.message}</p>
            {f.suggestions.length > 0 ? (
              <ul className="mt-1.5 space-y-1 text-xs text-ink-soft">
                {f.suggestions.map((s) => (
                  <li key={s} className="flex gap-2">
                    <span aria-hidden className="text-ink-faint">
                      →
                    </span>
                    {s}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
