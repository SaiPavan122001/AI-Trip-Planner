'use client';

import { formatMoney, type PlanResponse, type TripPlan } from '@/lib/api';

/**
 * The budget tracker, and the conflict resolver that goes with it.
 *
 * When a plan goes over budget, nothing is changed automatically. The traveller
 * is shown the gap and a list of adjustments with what each one actually
 * costs them, because silently downgrading a hotel to hit a number is the
 * behaviour that makes travel sites untrustworthy.
 */
export function BudgetPanel({
  plan,
  conflict,
  onApply,
}: {
  plan: TripPlan;
  conflict: PlanResponse['budgetConflict'];
  onApply: (utterance: string) => void;
}) {
  const { cost } = plan;
  const lines: Array<{ label: string; amount: typeof cost.transport }> = [
    { label: 'Transport', amount: cost.transport },
    { label: 'Taxes and fees', amount: cost.transportFees },
    { label: 'Accommodation', amount: cost.accommodation },
    { label: 'Local travel', amount: cost.localTransport },
    { label: 'Activities', amount: cost.activities },
    { label: 'Food', amount: cost.meals },
  ].filter((l) => l.amount.amount > 0);

  const total = cost.total.amount || 1;

  return (
    <section className="card p-5">
      <h2 className="font-display text-xl tracking-tight">What it costs</h2>

      <div
        className="mt-4 flex h-2 overflow-hidden rounded-full bg-sand-200"
        role="img"
        aria-label="Breakdown of the total by category"
      >
        {lines.map((line, i) => (
          <span
            key={line.label}
            className={BAR_COLORS[i % BAR_COLORS.length]}
            style={{ width: `${(line.amount.amount / total) * 100}%` }}
            title={`${line.label}: ${formatMoney(line.amount)}`}
          />
        ))}
      </div>

      <dl className="mt-4 space-y-2 text-sm">
        {lines.map((line, i) => (
          <div key={line.label} className="flex items-baseline justify-between gap-3">
            <dt className="flex items-center gap-2 text-ink-soft">
              <span
                aria-hidden
                className={`h-2 w-2 rounded-full ${BAR_COLORS[i % BAR_COLORS.length]}`}
              />
              {line.label}
            </dt>
            <dd className="tabular-nums">{formatMoney(line.amount)}</dd>
          </div>
        ))}
        <div className="flex items-baseline justify-between gap-3 border-t border-sand-200 pt-2.5 font-semibold">
          <dt>Total</dt>
          <dd className="tabular-nums">{formatMoney(cost.total)}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3 text-ink-soft">
          <dt>Per person</dt>
          <dd className="tabular-nums">{formatMoney(cost.perPerson)}</dd>
        </div>
      </dl>

      {cost.estimatedPortion.amount > 0 ? (
        <p className="mt-3 text-xs leading-relaxed text-ink-faint">
          <span className="estimate-chip">{formatMoney(cost.estimatedPortion)}</span> of this total
          is modelled from configured rates rather than quoted by a provider — local taxis, meals
          and anything a source priced as an estimate. Those items are marked in the timeline.
        </p>
      ) : null}

      {cost.remainingBudget && !conflict ? (
        <p className="mt-4 rounded-xl bg-teal-500/[0.08] px-4 py-3 text-sm text-teal-700">
          {formatMoney(cost.remainingBudget)} left against the budget you set.
        </p>
      ) : null}

      {conflict ? (
        <div className="mt-4 rounded-xl bg-clay/10 p-4">
          <h3 className="text-sm font-semibold text-clay">
            {formatMoney(conflict.overBy)} over your budget
          </h3>
          <p className="mt-1 text-xs text-clay/90">
            {formatMoney(conflict.total)} against a budget of {formatMoney(conflict.budget)}.
            Nothing has been changed — these are the options.
          </p>
          <ul className="mt-3 space-y-2">
            {conflict.adjustments.map((adjustment) => (
              <li key={adjustment.id} className="rounded-lg bg-white/70 p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-medium">{adjustment.label}</span>
                  {adjustment.estimatedSaving ? (
                    <span className="text-sm tabular-nums text-teal-600">
                      saves about {formatMoney(adjustment.estimatedSaving)}
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-xs text-ink-soft">{adjustment.tradeoff}</p>
                {ADJUSTMENT_UTTERANCE[adjustment.id] ? (
                  <button
                    type="button"
                    className="mt-2 text-xs font-medium text-teal-600 underline underline-offset-2"
                    onClick={() => onApply(ADJUSTMENT_UTTERANCE[adjustment.id]!)}
                  >
                    Try this
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

const BAR_COLORS = [
  'bg-teal-500',
  'bg-teal-600',
  'bg-clay',
  'bg-ink-faint',
  'bg-estimate',
  'bg-sand-300',
];

/**
 * Each adjustment maps to the plain-language request it stands for, so
 * clicking it goes through exactly the same modification path as typing it.
 * There is no privileged internal route that bypasses interpretation.
 */
const ADJUSTMENT_UTTERANCE: Record<string, string> = {
  'switch-transport': 'Use the cheaper transport option instead',
  'lower-hotel-tier': 'Find a cheaper hotel, one category down',
  'trim-activities': 'Remove the paid activities',
};
