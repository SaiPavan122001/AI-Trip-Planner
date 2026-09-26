'use client';

import type { AgentTraceEntry, TripSession } from '@/lib/api';

/**
 * The plain-language account of the plans, and how it was reached.
 *
 * The words are written from the checked facts of the plans: every figure in
 * them is one the plan contains, and anything that failed that check was
 * replaced by a plain sentence built from the facts. Where the planner
 * understood you through its rule-based fallback rather than a language
 * model, the trace says so, and nothing here pretends otherwise.
 */

const STAGE_LABEL: Record<string, string> = {
  transport_agent: 'How to travel',
  accommodation_agent: 'What the stay should be like',
  activity_agent: 'What to do there',
  guidance: 'Using what you said',
  plan_search: 'Searching providers and building plans',
  validation: 'Checking every plan',
  synthesis_agent: 'Writing this up',
};

const STATUS_TEXT: Record<AgentTraceEntry['status'], string> = {
  ok: 'done',
  degraded: 'done, with a fallback',
  failed: 'could not be done',
  skipped: 'nothing to do',
};

export function NarrativeCard({ trip, planId }: { trip: TripSession; planId: string | null }) {
  const narrative = trip.narrative;
  if (!narrative) return null;
  const forPlan = planId ? narrative.plans[planId] : null;

  return (
    <section className="card p-5" aria-label="In plain words">
      <h2 className="font-display text-xl tracking-tight">In plain words</h2>
      <p className="mt-3 text-sm leading-relaxed text-ink-soft">{narrative.summary}</p>
      {forPlan ? <p className="mt-3 border-t border-sand-200 pt-3 text-sm leading-relaxed text-ink-soft">{forPlan}</p> : null}
      <p className="mt-3 text-[11px] text-ink-faint">
        {narrative.source === 'template'
          ? 'Written from the facts of the plans.'
          : 'Written by a language model, and checked against the facts of the plans; any part that did not match them was replaced.'}
      </p>
    </section>
  );
}

export function AgentTrace({ trip }: { trip: TripSession }) {
  if (trip.agentTrace.length === 0) return null;
  return (
    <details className="card p-5">
      <summary className="cursor-pointer font-display text-xl tracking-tight">How this was put together</summary>
      <ol className="mt-4 space-y-3">
        {trip.agentTrace.map((entry) => (
          <li key={entry.stage} className="text-sm">
            <span className="font-medium">{STAGE_LABEL[entry.stage] ?? entry.stage}</span>
            <span className="ml-2 text-xs text-ink-faint">
              {STATUS_TEXT[entry.status]}
              {entry.source ? ` · ${entry.source === 'model' ? 'language model' : 'rules'}` : ''}
            </span>
            <p className="text-ink-soft">{entry.detail}</p>
            {entry.warnings.map((w) => (
              <p key={w} className="text-xs text-ink-faint">{w}</p>
            ))}
            {entry.rejected.length > 0 ? (
              <p className="text-xs text-ink-faint">
                {entry.rejected.length} suggestion{entry.rejected.length === 1 ? '' : 's'} left out because {entry.rejected.length === 1 ? 'it' : 'they'} did not match what you said.
              </p>
            ) : null}
          </li>
        ))}
      </ol>
    </details>
  );
}
