'use client';

import { formatLocalTime, formatMoney, type TripPlan } from '@/lib/api';

/**
 * The day-by-day timeline.
 *
 * Times are rendered in the timezone the item actually happens in, which is
 * why each item carries its own zone. For a trip that crosses zones, showing
 * everything in one timezone is the fastest way to make a traveller miss a
 * flight.
 *
 * Assumptions the scheduler had to make are printed under the item that
 * depends on them, not collected in a footnote nobody reads.
 */

const KIND_STYLE: Record<string, { dot: string; label: string }> = {
  transport: { dot: 'bg-teal-500', label: 'Journey' },
  transfer: { dot: 'bg-ink-faint', label: 'Transfer' },
  check_in: { dot: 'bg-teal-600', label: 'Check in' },
  check_out: { dot: 'bg-teal-600', label: 'Check out' },
  activity: { dot: 'bg-clay', label: 'Activity' },
  meal: { dot: 'bg-sand-300', label: 'Meal' },
  buffer: { dot: 'bg-sand-300', label: 'Allow time' },
  rest: { dot: 'bg-sand-300', label: 'Free' },
  stay: { dot: 'bg-teal-600', label: 'Stay' },
};

export function ItineraryTimeline({ plan }: { plan: TripPlan }) {
  if (plan.days.length === 0) {
    return (
      <section className="card p-5">
        <h2 className="font-display text-xl tracking-tight">Day by day</h2>
        <p className="mt-2 text-sm text-ink-soft">
          There is nothing to schedule yet: no transport or accommodation was found for this plan.
        </p>
      </section>
    );
  }

  return (
    <section>
      <h2 className="font-display text-xl tracking-tight">Day by day</h2>
      <p className="mt-1 text-sm text-ink-soft">
        Times are shown in the local time of the place each thing happens.
      </p>

      <ol className="mt-5 space-y-5">
        {plan.days.map((day, index) => (
          <li key={day.date} className="card overflow-hidden">
            <header className="flex items-baseline justify-between border-b border-sand-200 bg-sand-100/60 px-5 py-3">
              <div>
                <h3 className="text-sm font-semibold">
                  Day {index + 1} ·{' '}
                  {new Date(`${day.date}T12:00:00Z`).toLocaleDateString('en-GB', {
                    weekday: 'long',
                    day: 'numeric',
                    month: 'long',
                  })}
                </h3>
                <p className="text-[11px] text-ink-faint">{day.timezone.replace('_', ' ')}</p>
              </div>
              {day.daySubtotal.amount > 0 ? (
                <span className="text-sm tabular-nums text-ink-soft">
                  {formatMoney(day.daySubtotal)}
                </span>
              ) : null}
            </header>

            <div className="divide-y divide-sand-200">
              {day.items.map((item) => {
                const style = KIND_STYLE[item.kind] ?? KIND_STYLE['rest']!;
                return (
                  <div key={item.id} className="flex gap-4 px-5 py-4">
                    <div className="w-20 shrink-0 pt-0.5">
                      <p className="text-sm tabular-nums">
                        {formatLocalTime(item.startUtc, item.timezone)}
                      </p>
                      <p className="text-[11px] tabular-nums text-ink-faint">
                        to {formatLocalTime(item.endUtc, item.timezone)}
                      </p>
                    </div>

                    <div className="relative flex-1 pl-5">
                      <span
                        aria-hidden
                        className={`absolute left-0 top-2 h-2 w-2 rounded-full ${style.dot}`}
                      />
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <h4 className="text-sm font-medium">{item.title}</h4>
                        {item.cost && item.cost.amount > 0 ? (
                          <span className="flex items-center gap-1.5 text-sm tabular-nums">
                            {formatMoney(item.cost)}
                            {item.costIsEstimate ? (
                              <span className="estimate-chip">modelled</span>
                            ) : null}
                          </span>
                        ) : null}
                      </div>
                      <p className="text-[11px] uppercase tracking-wide text-ink-faint">
                        {style.label}
                        {item.locationName ? ` · ${item.locationName}` : ''}
                      </p>
                      {item.description ? (
                        <p className="mt-1.5 text-sm text-ink-soft">{item.description}</p>
                      ) : null}
                      {item.notes.length > 0 ? (
                        <ul className="mt-2 space-y-1">
                          {item.notes.map((note) => (
                            <li key={note} className="text-xs leading-relaxed text-ink-faint">
                              {note}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
