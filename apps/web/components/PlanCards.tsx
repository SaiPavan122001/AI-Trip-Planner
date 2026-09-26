'use client';

import { formatDuration, formatMoney, type TripPlan } from '@/lib/api';

/**
 * The alternatives. Three complete, validated plans built from the same live
 * search results, each optimised for a different reading of "best".
 *
 * Blockers are shown on the card itself rather than hidden behind a click: a
 * plan that cannot be executed should never look like one that can.
 */
export function PlanCards({
  plans,
  selectedId,
  onSelect,
}: {
  plans: TripPlan[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (plans.length === 0) return null;

  return (
    <section>
      <h2 className="font-display text-xl tracking-tight">Your alternatives</h2>
      <p className="mt-1 text-sm text-ink-soft">
        Ordered by how well each matches the priorities you ranked.
      </p>

      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        {plans.map((plan) => {
          const selected = plan.id === selectedId;
          const blockers = plan.issues.filter((i) => i.severity === 'blocker');
          const warnings = plan.issues.filter((i) => i.severity === 'warning');

          return (
            <article
              key={plan.id}
              className={`card flex flex-col p-5 transition ${
                selected ? 'ring-2 ring-teal-500' : 'hover:shadow-lift'
              }`}
            >
              <header>
                <div className="flex items-center justify-between">
                  <h3 className="font-display text-lg tracking-tight">{plan.label}</h3>
                  <span className="rounded-full bg-sand-100 px-2.5 py-1 text-[11px] tabular-nums text-ink-faint">
                    {Math.round(plan.priorityScore * 100)}% match
                  </span>
                </div>
                <p className="mt-3 text-2xl font-semibold tabular-nums">
                  {formatMoney(plan.cost.total)}
                </p>
                <p className="text-xs text-ink-faint">
                  {formatMoney(plan.cost.perPerson)} per person, everything included
                </p>
              </header>

              <p className="mt-4 text-sm leading-relaxed text-ink-soft">{plan.rationale}</p>

              <dl className="mt-4 space-y-1.5 border-t border-sand-200 pt-4 text-sm">
                <Row
                  label="Transport"
                  value={
                    plan.outboundTransport
                      ? `${plan.outboundTransport.mode.replace('_', ' ')}, ${formatDuration(
                          plan.outboundTransport.totalDurationMinutes,
                        )}`
                      : 'none found'
                  }
                  amount={formatMoney(plan.cost.transport)}
                />
                {plan.hotels[0] ? (
                  <Row
                    label="Stay"
                    value={`${plan.hotels[0].hotel.name}${
                      plan.hotels[0].hotel.category ? ` · ${plan.hotels[0].hotel.category}★` : ''
                    }`}
                    amount={formatMoney(plan.cost.accommodation)}
                  />
                ) : null}
                <Row label="Local travel" value="transfers and getting around" amount={formatMoney(plan.cost.localTransport)} />
                <Row label="Food" value="from your daily allowance" amount={formatMoney(plan.cost.meals)} />
              </dl>

              {plan.cost.estimatedPortion.amount > 0 ? (
                <p className="mt-3">
                  <span className="estimate-chip">
                    {formatMoney(plan.cost.estimatedPortion)} modelled, not quoted
                  </span>
                </p>
              ) : null}

              {plan.cost.notIncluded.length > 0 ? (
                <p className="mt-2 text-xs text-ink-faint">
                  Not included: {plan.cost.notIncluded.map((n) => n.label.toLowerCase()).join(', ')}.
                </p>
              ) : null}

              {plan.tradeoffs.length > 0 ? (
                <ul className="mt-4 space-y-1.5 text-xs text-ink-soft">
                  {plan.tradeoffs.map((t) => (
                    <li key={t} className="flex gap-2">
                      <span aria-hidden className="text-ink-faint">
                        —
                      </span>
                      {t}
                    </li>
                  ))}
                </ul>
              ) : null}

              {plan.choices.length > 0 ? (
                <details className="mt-3 text-xs">
                  <summary className="cursor-pointer text-ink-faint">Why this plan</summary>
                  <ul className="mt-2 space-y-3 text-ink-soft">
                    {plan.choices.map((c) => (
                      <li key={`${c.topic}-${c.chosen}`}>
                        <p className="font-medium text-ink">{c.chosen}</p>
                        <p>{c.why}</p>
                        {c.alternatives.length > 0 ? (
                          <ul className="mt-1 space-y-0.5 text-ink-faint">
                            {c.alternatives.map((a) => (
                              <li key={a.label}>
                                Not taken: {a.label}
                                {a.note ? ` (${a.note})` : ''}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}

              {blockers.length > 0 ? (
                <div className="mt-4 rounded-xl bg-clay/10 p-3">
                  <p className="text-xs font-semibold text-clay">
                    Cannot be booked as it stands
                  </p>
                  <ul className="mt-1.5 space-y-1 text-xs text-clay/90">
                    {blockers.map((b) => (
                      <li key={b.code}>{b.message}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {warnings.length > 0 ? (
                <details className="mt-3 text-xs">
                  <summary className="cursor-pointer text-ink-faint">
                    {warnings.length} thing{warnings.length === 1 ? '' : 's'} worth knowing
                  </summary>
                  <ul className="mt-2 space-y-1.5 text-ink-soft">
                    {warnings.map((w) => (
                      <li key={w.code}>{w.message}</li>
                    ))}
                  </ul>
                </details>
              ) : null}

              <div className="mt-auto pt-5">
                <button
                  type="button"
                  className={selected ? 'btn-ghost w-full' : 'btn-primary w-full'}
                  onClick={() => onSelect(plan.id)}
                  disabled={selected}
                >
                  {selected ? 'Showing this plan' : 'See this plan'}
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function Row({ label, value, amount }: { label: string; value: string; amount: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-ink-faint">{label}</dt>
      <dd className="flex min-w-0 flex-1 items-baseline justify-end gap-2">
        <span className="truncate text-xs text-ink-soft">{value}</span>
        <span className="shrink-0 tabular-nums">{amount}</span>
      </dd>
    </div>
  );
}
