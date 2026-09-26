'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ApiClientError,
  api,
  formatMoney,
  isActiveRun,
  type ModifyResponse,
  type PlanningRun,
  type TripPlan,
  type TripSession,
} from '@/lib/api';
import { useRunWatcher } from '@/lib/useRunWatcher';
import { BudgetPanel } from '@/components/BudgetPanel';
import { ItineraryTimeline } from '@/components/ItineraryTimeline';
import { ModifyBar } from '@/components/ModifyBar';
import { PinsPanel } from '@/components/PinsPanel';
import { PlanCards } from '@/components/PlanCards';
import { PlanningProgress } from '@/components/PlanningProgress';
import { QuestionCard } from '@/components/QuestionCard';
import { TransportComparison } from '@/components/TransportComparison';

/**
 * The trip workspace. It has two modes, and which one it is in is decided by
 * the engine, not by this component: while there is a next question, it is an
 * interview; once the engine says it has enough, it is a plan.
 *
 * Searching happens in the background on the server. This page starts a
 * search, follows its progress, and reads the plans from the trip when it is
 * done, so leaving the page, reloading it, or opening it on another device
 * finds the search exactly where it is.
 */
export default function TripPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [trip, setTrip] = useState<TripSession | null>(null);
  const [run, setRun] = useState<PlanningRun | null>(null);
  const [lastModification, setLastModification] = useState<ModifyResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Kept parts that could not be kept, each with the reason: never dropped silently. */
  const [released, setReleased] = useState<Array<{ component: string; reason: string }>>([]);
  const [pinRefusals, setPinRefusals] = useState<Array<{ component: string; reason: string }>>([]);

  const searching = isActiveRun(run);

  const refresh = useCallback(async () => {
    const { trip: loaded, run: latest } = await api.getTrip(id);
    setTrip(loaded);
    setRun(latest);
  }, [id]);

  useEffect(() => {
    api
      .getTrip(id)
      .then(({ trip: loaded, run: latest }) => {
        setTrip(loaded);
        setRun(latest);
      })
      .catch((err) =>
        setError(err instanceof ApiClientError ? err.message : 'This trip could not be loaded.'),
      );
  }, [id]);

  // Follow a running search. When it ends, read the plans it saved.
  useRunWatcher(
    id,
    run,
    (latest) => {
      setRun(latest);
      if (!isActiveRun(latest)) {
        setCancelling(false);
        refresh().catch(() => setError('The search finished, but the trip could not be reloaded.'));
      }
    },
    (message) => setError(message),
  );

  const answer = useCallback(
    async (value: unknown, skipped = false) => {
      if (!trip?.questionnaire?.next) return;
      setBusy(true);
      setError(null);
      try {
        const { trip: updated } = await api.answer(
          id,
          trip.questionnaire.next.key,
          skipped ? null : value,
          skipped,
        );
        setTrip(updated);
      } catch (err) {
        setError(err instanceof ApiClientError ? err.message : 'That answer could not be saved.');
      } finally {
        setBusy(false);
      }
    },
    [id, trip],
  );

  const runPlan = useCallback(async () => {
    setBusy(true);
    setError(null);
    setReleased([]);
    try {
      const started = await api.plan(id);
      setTrip(started.trip);
      setRun(started.run);
      setReleased(started.pinsReleased);
    } catch (err) {
      const active = err instanceof ApiClientError ? (err.failure.details as { run?: PlanningRun } | undefined)?.run : undefined;
      if (active) setRun(active);
      setError(err instanceof ApiClientError ? err.message : 'The search could not be started.');
    } finally {
      setBusy(false);
    }
  }, [id]);

  const cancelSearch = useCallback(async () => {
    if (!run) return;
    setCancelling(true);
    try {
      const { run: updated } = await api.cancelRun(id, run.id);
      setRun(updated);
      if (!isActiveRun(updated)) {
        setCancelling(false);
        await refresh();
      }
    } catch (err) {
      setCancelling(false);
      setError(err instanceof ApiClientError ? err.message : 'The search could not be stopped.');
    }
  }, [id, run, refresh]);

  // One path for a change and for the answer to its question. Plans always
  // follow the response: when a change clears plans that no longer fit the
  // trip (new dates, a different group), the old ones must not stay on screen.
  const applyModification = useCallback(async (request: () => Promise<ModifyResponse>) => {
    setBusy(true);
    setError(null);
    try {
      const result = await request();
      setLastModification(result);
      setTrip(result.trip);
      setReleased(result.released);
      if (result.run) setRun(result.run);
    } catch (err) {
      const active = err instanceof ApiClientError ? (err.failure.details as { run?: PlanningRun } | undefined)?.run : undefined;
      if (active) setRun(active);
      setError(err instanceof ApiClientError ? err.message : 'That change could not be applied.');
    } finally {
      setBusy(false);
    }
  }, []);

  const modify = useCallback(
    (utterance: string) => applyModification(() => api.modify(id, utterance)),
    [id, applyModification],
  );

  const answerModification = useCallback(
    (pendingId: string, accept: boolean) =>
      applyModification(() => api.answerModification(id, pendingId, accept)),
    [id, applyModification],
  );

  const selectPlan = useCallback(
    async (planId: string) => {
      setTrip((current) => (current ? { ...current, selectedPlanId: planId } : current));
      // Pins are about the selected plan's parts, so they are looked at again.
      await api.selectPlan(id, planId).catch(() => undefined);
    },
    [id],
  );

  const changePins = useCallback(
    async (pins: string[]) => {
      setTrip((current) => (current ? { ...current, pins } : current));
      try {
        const result = await api.setPins(id, pins);
        setTrip(result.trip);
        setPinRefusals(result.refused);
      } catch (err) {
        setError(err instanceof ApiClientError ? err.message : 'That could not be saved.');
        await refresh().catch(() => undefined);
      }
    },
    [id, refresh],
  );

  if (error && !trip) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-20 text-center">
        <h1 className="font-display text-2xl">This trip could not be opened</h1>
        <p className="mt-3 text-ink-soft">{error}</p>
        <Link href="/" className="btn-primary mt-6">
          Start a new trip
        </Link>
      </div>
    );
  }

  if (!trip) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-20 text-center text-ink-faint">Loading trip…</div>
    );
  }

  const plans = trip.plans;
  const selectedPlan = plans.find((p) => p.id === trip.selectedPlanId) ?? plans[0] ?? null;
  const question = trip.questionnaire?.next ?? null;
  const search = trip.lastSearch;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <TripHeader trip={trip} />

      {error ? (
        <p role="alert" className="mt-5 rounded-xl bg-clay/10 px-4 py-3 text-sm text-clay">
          {error}
        </p>
      ) : null}

      {released.length > 0 ? (
        <div role="status" className="mt-5 rounded-xl bg-clay/10 px-4 py-3 text-sm text-clay">
          <p className="font-medium">Some of what you asked to keep could not be kept:</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {released.map((r) => (
              <li key={r.component}>{r.reason}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {question ? (
        <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <QuestionCard
            question={question}
            progress={trip.questionnaire?.completeness ?? 0}
            busy={busy}
            onAnswer={(value) => void answer(value)}
            onSkip={() => void answer(null, true)}
          />
          <aside className="space-y-4">
            <ClassificationCard trip={trip} />
            {trip.questionnaire?.canPlan ? (
              <div className="card p-5">
                <p className="text-sm text-ink-soft">
                  There is already enough to search. You can answer the rest afterwards.
                </p>
                <button
                  type="button"
                  className="btn-ghost mt-3 w-full"
                  onClick={() => void runPlan()}
                  disabled={busy || searching}
                >
                  {searching ? 'Searching…' : 'Skip ahead and search now'}
                </button>
              </div>
            ) : null}
            {searching && run ? (
              <PlanningProgress run={run} onCancel={() => void cancelSearch()} cancelling={cancelling} />
            ) : null}
          </aside>
        </div>
      ) : (
        <div className="mt-8 space-y-8">
          {searching && run ? (
            <PlanningProgress run={run} onCancel={() => void cancelSearch()} cancelling={cancelling} />
          ) : null}

          {!searching && run ? <RunOutcome run={run} /> : null}

          {plans.length === 0 && !searching ? (
            <section className="card p-6">
              <h2 className="font-display text-xl tracking-tight">Ready to search</h2>
              <p className="mt-2 text-sm text-ink-soft">
                Every connected provider will be searched for each mode that suits this journey.
                It runs in the background, so you can leave this page open or come back later.
              </p>
              <button
                type="button"
                className="btn-primary mt-4"
                onClick={() => void runPlan()}
                disabled={busy}
              >
                {run && run.status !== 'succeeded' ? 'Search again' : 'Build my plans'}
              </button>
            </section>
          ) : null}

          {search && plans.length > 0 ? (
            <TransportComparison
              modes={search.outbound.modes}
              filtered={search.outbound.filteredByYourRequirements}
              timezone={trip.classification.originTimezone}
            />
          ) : null}

          <PlanCards plans={plans} selectedId={selectedPlan?.id ?? null} onSelect={(p) => void selectPlan(p)} />

          {selectedPlan ? (
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
              <div className="space-y-6">
                {selectedPlan.hotels[0] ? <StayCard plan={selectedPlan} pinned={trip.pins.includes('hotel')} /> : null}
                <ItineraryTimeline plan={selectedPlan} />
              </div>
              <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
                <BudgetPanel
                  plan={selectedPlan}
                  conflict={search?.budgetConflict ?? null}
                  firm={trip.constraints.budget.firm}
                  onApply={(utterance) => void modify(utterance)}
                />
                <PinsPanel
                  plan={selectedPlan}
                  pins={trip.pins}
                  disabled={busy || searching}
                  refused={pinRefusals}
                  onChange={(pins) => void changePins(pins)}
                />
                <ModifyBar
                  busy={busy || searching}
                  lastResult={lastModification}
                  pending={trip.pendingModification}
                  onSubmit={(utterance) => void modify(utterance)}
                  onAnswer={(pendingId, accept) => void answerModification(pendingId, accept)}
                />
              </aside>
            </div>
          ) : null}

          <ProviderNotes trip={trip} />
          <DecisionLog trip={trip} />
        </div>
      )}
    </div>
  );
}

/** What became of the last search, when it did not end with plans. */
function RunOutcome({ run }: { run: PlanningRun }) {
  const text: Record<string, string> = {
    failed: run.error?.message ?? 'The search did not finish. Nothing was booked or charged.',
    cancelled: 'You stopped that search. Your trip is unchanged.',
    superseded:
      'The trip changed while it was being searched, so those results were thrown away rather than shown against the wrong trip. Search again to see plans for the trip as it is now.',
  };
  const message = text[run.status];
  if (!message) return null;
  return (
    <p role="status" className="rounded-xl bg-sand-100 px-4 py-3 text-sm text-ink-soft">
      {message}
    </p>
  );
}

function TripHeader({ trip }: { trip: TripSession }) {
  const { intent, classification } = trip;
  const travellers =
    intent.travelers.adults + intent.travelers.children + intent.travelers.infants;

  return (
    <header>
      <p className="text-xs uppercase tracking-[0.16em] text-teal-500">
        {classification.scope === 'international' ? 'International journey' : 'Domestic journey'} ·{' '}
        {classification.greatCircleKm.toLocaleString()} km
      </p>
      <h1 className="mt-2 font-display text-3xl tracking-tight sm:text-4xl">
        {intent.origin.name} → {intent.destination.name}
      </h1>
      <p className="mt-2 text-sm text-ink-soft">
        {new Date(`${intent.departureDate}T12:00:00Z`).toLocaleDateString('en-GB', {
          day: 'numeric',
          month: 'long',
          year: 'numeric',
        })}
        {intent.returnDate
          ? ` – ${new Date(`${intent.returnDate}T12:00:00Z`).toLocaleDateString('en-GB', {
              day: 'numeric',
              month: 'long',
              year: 'numeric',
            })}`
          : ' · one way'}{' '}
        · {travellers} traveller{travellers === 1 ? '' : 's'} · {intent.currency}
      </p>
    </header>
  );
}

function ClassificationCard({ trip }: { trip: TripSession }) {
  const { classification } = trip;
  return (
    <div className="card p-5">
      <h2 className="text-sm font-semibold">What will be searched</h2>
      <ul className="mt-3 flex flex-wrap gap-1.5">
        {classification.eligibleModes.map((mode) => (
          <li
            key={mode}
            className="rounded-full bg-teal-500/10 px-2.5 py-1 text-xs capitalize text-teal-700"
          >
            {mode.replace('_', ' ')}
          </li>
        ))}
      </ul>
      {classification.excludedModes.length > 0 ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-ink-faint">
            {classification.excludedModes.length} mode
            {classification.excludedModes.length === 1 ? '' : 's'} ruled out
          </summary>
          <ul className="mt-2 space-y-1.5 text-xs text-ink-soft">
            {classification.excludedModes.map((m) => (
              <li key={m.mode}>
                <span className="capitalize">{m.mode.replace('_', ' ')}</span>: {m.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {classification.documentationNotes.map((note) => (
        <p key={note} className="mt-3 text-xs leading-relaxed text-ink-faint">
          {note}
        </p>
      ))}
    </div>
  );
}

function StayCard({ plan, pinned }: { plan: TripPlan; pinned: boolean }) {
  const stay = plan.hotels[0];
  if (!stay) return null;

  return (
    <section className="card p-5">
      <h2 className="font-display text-xl tracking-tight">
        Where you stay
        {pinned ? (
          <span className="ml-2 rounded-full bg-teal-500/10 px-2.5 py-1 align-middle text-xs font-normal text-teal-700">
            kept as you asked
          </span>
        ) : null}
      </h2>
      <div className="mt-4 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold">
            {stay.hotel.name}
            {stay.hotel.category ? (
              <span className="ml-2 text-sm font-normal text-ink-faint">
                {stay.hotel.category}★
              </span>
            ) : null}
          </h3>
          {stay.hotel.address ? (
            <p className="text-sm text-ink-soft">{stay.hotel.address}</p>
          ) : null}
        </div>
        <p className="text-right">
          <span className="block text-lg font-semibold tabular-nums">
            {formatMoney(stay.room.totalPrice)}
          </span>
          <span className="text-xs text-ink-faint">
            {formatMoney(stay.room.pricePerNight)} per night · {stay.nights} night
            {stay.nights === 1 ? '' : 's'} · {stay.rooms} room{stay.rooms === 1 ? '' : 's'}
          </span>
        </p>
      </div>

      <p className="mt-3 text-sm text-ink-soft">{stay.room.description}</p>

      <ul className="mt-3 flex flex-wrap gap-1.5">
        {stay.room.breakfastIncluded ? <Tag>Breakfast included</Tag> : null}
        {stay.room.refundable === true ? <Tag>Free cancellation</Tag> : null}
        {stay.room.refundable === false ? <Tag tone="warn">Non-refundable</Tag> : null}
        {stay.hotel.amenities.slice(0, 5).map((a) => (
          <Tag key={a}>{a.toLowerCase().replace(/_/g, ' ')}</Tag>
        ))}
      </ul>

      {stay.distanceToActivitiesKm !== null ? (
        <p className="mt-3 text-xs leading-relaxed text-ink-faint">
          About {stay.distanceToActivitiesKm.toFixed(1)} km from the middle of your planned days
          {stay.impliedDailyTransportCost
            ? `, which this plan costs at roughly ${formatMoney(
                stay.impliedDailyTransportCost,
              )} a day in local travel.`
            : '.'}{' '}
          That cost is counted in the total, so a cheaper room further out does not look cheaper
          than it is.
        </p>
      ) : null}

      {stay.room.cancellationPolicy ? (
        <p className="mt-2 text-xs text-ink-faint">{stay.room.cancellationPolicy}</p>
      ) : null}

      <p className="mt-3 border-t border-sand-200 pt-3 text-[11px] text-ink-faint">
        {stay.hotel.provenance.providerLabel}, retrieved{' '}
        {new Date(stay.hotel.provenance.retrievedAt).toLocaleString('en-GB')}
      </p>
    </section>
  );
}

function Tag({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'warn' }) {
  return (
    <li
      className={`rounded-full px-2.5 py-1 text-xs capitalize ${
        tone === 'warn' ? 'bg-clay/10 text-clay' : 'bg-sand-100 text-ink-soft'
      }`}
    >
      {children}
    </li>
  );
}

function ProviderNotes({ trip }: { trip: TripSession }) {
  if (trip.providerNotes.length === 0) return null;
  return (
    <section className="card p-5">
      <h2 className="font-display text-xl tracking-tight">What could not be searched</h2>
      <p className="mt-1 text-sm text-ink-soft">
        These gaps are reported rather than filled in with estimates.
      </p>
      <ul className="mt-4 space-y-3">
        {trip.providerNotes.map((note, i) => (
          <li key={`${note.provider}-${i}`} className="border-l-2 border-sand-300 pl-3">
            <p className="text-xs uppercase tracking-wide text-ink-faint">
              {note.providerLabel} · {note.status.replace(/_/g, ' ')}
            </p>
            <p className="mt-0.5 text-sm text-ink-soft">{note.message}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function DecisionLog({ trip }: { trip: TripSession }) {
  if (trip.decisionLog.length === 0) return null;
  return (
    <details className="card p-5">
      <summary className="cursor-pointer font-display text-xl tracking-tight">
        How this plan was reached
      </summary>
      <ol className="mt-4 space-y-2.5">
        {trip.decisionLog.map((entry, i) => (
          <li key={`${entry.step}-${i}`} className="text-sm">
            <span className="text-xs uppercase tracking-wide text-ink-faint">
              {entry.step.replace(/_/g, ' ')}
            </span>
            <p className="text-ink-soft">{entry.detail}</p>
          </li>
        ))}
      </ol>
    </details>
  );
}
