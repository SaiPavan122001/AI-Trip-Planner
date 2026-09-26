'use client';

import {
  formatDuration,
  formatLocalTime,
  formatMoney,
  type ModeSummary,
  type TransportOffer,
} from '@/lib/api';

/**
 * Side-by-side comparison of every way of making the journey.
 *
 * The point of this screen is that no mode is preselected and none is declared
 * "best" on its own. Each column shows the cheapest and the fastest option
 * that mode can offer, plus the one that scores highest against the
 * traveller's own ranking, so the trade-off between them is visible rather
 * than resolved on their behalf.
 */

const MODE_LABEL: Record<string, string> = {
  flight: 'Flight',
  train: 'Train',
  bus: 'Bus',
  self_drive: 'Drive yourself',
  rental_car: 'Rental car',
  taxi: 'Private car',
  ferry: 'Ferry',
};

export function TransportComparison({
  modes,
  filtered,
  timezone,
}: {
  modes: ModeSummary[];
  filtered: Array<{ offerId: string; reason: string }>;
  timezone: string;
}) {
  const withOptions = modes.filter((m) => m.optionCount > 0);
  const without = modes.filter((m) => m.optionCount === 0);

  return (
    <section>
      <h2 className="font-display text-xl tracking-tight">Ways of getting there</h2>
      <p className="mt-1 text-sm text-ink-soft">
        Every mode that makes sense for this route was searched. Nothing below is a recommendation
        on its own — the trade-offs are stated so you can decide.
      </p>

      {withOptions.length > 0 ? (
        <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {withOptions.map((mode) => (
            <article key={mode.mode} className="card flex flex-col p-5">
              <header className="flex items-baseline justify-between">
                <h3 className="text-base font-semibold">{MODE_LABEL[mode.mode] ?? mode.mode}</h3>
                <span className="text-xs text-ink-faint">
                  {mode.optionCount} option{mode.optionCount === 1 ? '' : 's'}
                </span>
              </header>

              <div className="mt-4 space-y-3">
                <OfferLine label="Cheapest" offer={mode.cheapest} timezone={timezone} />
                <OfferLine label="Fastest" offer={mode.fastest} timezone={timezone} />
                <OfferLine label="Best for you" offer={mode.bestForYou} timezone={timezone} highlight />
              </div>

              {mode.bestForYou?.provenance ? (
                <p className="mt-4 border-t border-sand-200 pt-3 text-[11px] text-ink-faint">
                  {mode.bestForYou.provenance.providerLabel}, retrieved{' '}
                  {new Date(mode.bestForYou.provenance.retrievedAt).toLocaleString('en-GB')}
                </p>
              ) : null}
            </article>
          ))}
        </div>
      ) : null}

      {without.length > 0 ? (
        <div className="mt-5 card p-5">
          <h3 className="text-sm font-semibold">Modes with nothing to show</h3>
          <ul className="mt-3 space-y-2.5">
            {without.map((mode) => (
              <li key={mode.mode} className="text-sm">
                <span className="font-medium">{MODE_LABEL[mode.mode] ?? mode.mode}: </span>
                <span className="text-ink-soft">
                  {mode.unavailableReason?.message ??
                    'No options were returned for this route on these dates.'}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-ink-faint">
            &ldquo;Not configured&rdquo; means this deployment has no provider connected for that
            mode — not that no service exists.
          </p>
        </div>
      ) : null}

      {filtered.length > 0 ? (
        <details className="mt-4 card p-5">
          <summary className="cursor-pointer text-sm font-semibold">
            {filtered.length} option{filtered.length === 1 ? '' : 's'} ruled out by your own
            requirements
          </summary>
          <ul className="mt-3 space-y-2 text-sm text-ink-soft">
            {filtered.map((f) => (
              <li key={f.offerId}>{f.reason}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

function OfferLine({
  label,
  offer,
  timezone,
  highlight = false,
}: {
  label: string;
  offer: TransportOffer | null;
  timezone: string;
  highlight?: boolean;
}) {
  if (!offer) {
    return (
      <div className="text-sm text-ink-faint">
        <span className="font-medium">{label}: </span>none
      </div>
    );
  }

  const first = offer.segments[0];
  const last = offer.segments[offer.segments.length - 1];

  return (
    <div
      className={`rounded-xl px-3 py-2.5 ${
        highlight ? 'bg-teal-500/[0.07] ring-1 ring-inset ring-teal-500/20' : 'bg-sand-100'
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-ink-faint">{label}</span>
        <span className="text-sm font-semibold tabular-nums">{formatMoney(offer.totalPrice)}</span>
      </div>
      <ExtraCosts offer={offer} />
      <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-ink-soft">
        <span className="tabular-nums">{formatDuration(offer.totalDurationMinutes)}</span>
        <span aria-hidden>·</span>
        <span>
          {offer.transfers === 0 ? 'direct' : `${offer.transfers} change${offer.transfers > 1 ? 's' : ''}`}
        </span>
        {first && last ? (
          <>
            <span aria-hidden>·</span>
            <span className="tabular-nums">
              {formatLocalTime(first.departureAt, timezone)} →{' '}
              {formatLocalTime(last.arrivalAt, timezone)}
            </span>
          </>
        ) : null}
        {offer.overnight ? (
          <>
            <span aria-hidden>·</span>
            <span className="text-clay">overnight</span>
          </>
        ) : null}
      </div>
      {offer.segments[0]?.operatorName || offer.segments[0]?.serviceNumber ? (
        <p className="mt-1 text-[11px] text-ink-faint">
          {offer.segments
            .map((s) => s.serviceNumber ?? s.operatorName)
            .filter(Boolean)
            .join(' · ')}
        </p>
      ) : null}
      {offer.fareClasses.length > 0 ? (
        <p className="mt-1 text-[11px] text-ink-faint">
          {offer.fareClasses.map((f) => f.label).join(' · ')}
          {offer.fareClasses[0]?.availabilityLabel
            ? ` — ${offer.fareClasses[0].availabilityLabel}`
            : ''}
        </p>
      ) : null}
    </div>
  );
}

/**
 * What the option costs beyond its fare. Estimated extras (fuel for a drive)
 * carry the estimate colour and their basis; costs nothing can price (tolls,
 * parking) are named as not calculated, never shown as ₹0.
 */
function ExtraCosts({ offer }: { offer: TransportOffer }) {
  const extras = offer.itemisedFees.filter((f) => !f.included);
  if (extras.length === 0 && offer.unpricedCosts.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5 text-[11px] text-ink-soft">
      {extras.map((fee) => (
        <li key={fee.label} title={fee.basis ?? undefined}>
          + {fee.isEstimate ? <span className="estimate-chip">{formatMoney(fee.amount)}</span> : formatMoney(fee.amount)}{' '}
          {fee.label.toLowerCase()}
          {fee.isEstimate ? ' (estimated)' : ''}
        </li>
      ))}
      {offer.unpricedCosts.length > 0 ? (
        <li className="text-ink-faint">
          {offer.unpricedCosts.join(', ')}: not calculated
        </li>
      ) : null}
    </ul>
  );
}
