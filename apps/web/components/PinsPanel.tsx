'use client';

import { formatMoney, type TripPlan } from '@/lib/api';

/**
 * Parts of the selected plan the traveller wants to keep. A kept part is used
 * exactly as it is when anything else changes, until a change makes it
 * impossible to keep (new dates, say), and then the traveller is told which
 * part was let go and why. Nothing is kept or dropped silently.
 */

interface Option {
  component: 'outbound' | 'return' | 'hotel' | 'activities';
  label: string;
  detail: string;
}

function optionsFor(plan: TripPlan): Option[] {
  const options: Option[] = [];
  const leg = (offer: NonNullable<TripPlan['outboundTransport']>) => {
    const first = offer.segments[0]!;
    const name = first.operatorName ?? offer.mode.replace('_', ' ');
    // Segment times are local wall-clock times at the departure point.
    return `${name}, ${first.departureAt.slice(11, 16)}, ${formatMoney(offer.totalPrice)}`;
  };
  if (plan.outboundTransport) {
    options.push({ component: 'outbound', label: 'Outbound journey', detail: leg(plan.outboundTransport) });
  }
  if (plan.returnTransport) {
    options.push({ component: 'return', label: 'Return journey', detail: leg(plan.returnTransport) });
  }
  const stay = plan.hotels[0];
  if (stay) {
    options.push({
      component: 'hotel',
      label: 'Hotel',
      detail: `${stay.hotel.name}, ${formatMoney(stay.room.totalPrice)}`,
    });
  }
  if (plan.activities.length > 0) {
    options.push({
      component: 'activities',
      label: 'Things to do',
      detail: `${plan.activities.length} chosen place${plan.activities.length === 1 ? '' : 's'}`,
    });
  }
  return options;
}

export function PinsPanel({
  plan,
  pins,
  disabled,
  refused,
  onChange,
}: {
  plan: TripPlan;
  pins: string[];
  disabled: boolean;
  refused: Array<{ component: string; reason: string }>;
  onChange: (pins: string[]) => void;
}) {
  const options = optionsFor(plan);
  if (options.length === 0) return null;

  const toggle = (component: string) =>
    onChange(pins.includes(component) ? pins.filter((p) => p !== component) : [...pins, component]);

  return (
    <section className="card p-5">
      <h2 className="font-display text-xl tracking-tight">Keep what you like</h2>
      <p className="mt-1 text-sm text-ink-soft">
        Tick a part to keep it exactly as it is while everything else changes. If a change makes it
        impossible to keep, you will be told which part and why.
      </p>
      <ul className="mt-4 space-y-2">
        {options.map((option) => {
          const id = `pin-${option.component}`;
          const checked = pins.includes(option.component);
          return (
            <li key={option.component}>
              <label
                htmlFor={id}
                className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 text-sm transition ${
                  checked ? 'border-teal-500 bg-teal-500/[0.06]' : 'border-sand-200 bg-white'
                } ${disabled ? 'opacity-60' : ''}`}
              >
                <input
                  id={id}
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 accent-teal-600"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => toggle(option.component)}
                />
                <span>
                  <span className="block font-medium">{option.label}</span>
                  <span className="block text-xs text-ink-soft">{option.detail}</span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      {refused.length > 0 ? (
        <ul className="mt-3 space-y-1 text-xs text-clay">
          {refused.map((r) => (
            <li key={r.component}>{r.reason}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
