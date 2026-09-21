'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ApiClientError,
  api,
  formatMoney,
  type ModifyResponse,
  type PlanResponse,
  type TripPlan,
  type TripSession,
} from '@/lib/api';
import { BudgetPanel } from '@/components/BudgetPanel';
import { ItineraryTimeline } from '@/components/ItineraryTimeline';
import { ModifyBar } from '@/components/ModifyBar';
import { PlanCards } from '@/components/PlanCards';
import { QuestionCard } from '@/components/QuestionCard';
import { TransportComparison } from '@/components/TransportComparison';

/**
 * The trip workspace. It has two modes, and which one it is in is decided by
 * the engine, not by this component: while there is a next question, it is an
 * interview; once the engine says it has enough, it is a plan.
 */
export default function TripPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [trip, setTrip] = useState<TripSession | null>(null);
  const [planResult, setPlanResult] = useState<PlanResponse | null>(null);
  const [lastModification, setLastModification] = useState<ModifyResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getTrip(id)
      .then(({ trip: loaded }) => setTrip(loaded))
      .catch((err) =>
        setError(err instanceof ApiClientError ? err.message : 'This trip could not be loaded.'),
      );
  }, [id]);

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
    setPlanning(true);
    setError(null);
    try {
      const result = await api.plan(id);
      setPlanResult(result);
      setTrip(result.trip);
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : 'The search could not be completed.',
      );
    } finally {
      setPlanning(false);
    }
  }, [id]);

  const modify = useCallback(
    async (utterance: string) => {
      setBusy(true);
      setError(null);
      try {
        const result = await api.modify(id, utterance);
        setLastModification(result);
        setTrip(result.trip);
        if (result.plans.length > 0) {
          setPlanResult((current) =>
            current
              ? { ...current, plans: result.plans, budgetConflict: result.budgetConflict, trip: result.trip }
              : current,
          );
        }
      } catch (err) {
        setError(err instanceof ApiClientError ? err.message : 'That change could not be applied.');
      } finally {
        setBusy(false);
      }
    },
    [id],
  );

  const selectPlan = useCallback(
    async (planId: string) => {
      setTrip((current) => (current ? { ...current, selectedPlanId: planId } : current));
      await api.selectPlan(id, planId).catch(() => undefined);
    },
    [id],
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

  const plans = planResult?.plans ?? trip.plans;
  const selectedPlan = plans.find((p) => p.id === trip.selectedPlanId) ?? plans[0] ?? null;
  const question = trip.questionnaire?.next ?? null;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <TripHeader trip={trip} />

      {error ? (
        <p role="alert" className="mt-5 rounded-xl bg-clay/10 px-4 py-3 text-sm text-clay">
          {error}
        </p>
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
                  disabled={planning}
                >
                  {planning ? 'Searching…' : 'Skip ahead and search now'}
                </button>
              </div>
            ) : null}
          </aside>
        </div>
      ) : (
        <div className="mt-8 space-y-8">
          {plans.length === 0 ? (
            <section className="card p-6">
              <h2 className="font-display text-xl tracking-tight">Ready to search</h2>
              <p className="mt-2 text-sm text-ink-soft">
                Every connected provider will be searched for each mode that suits this journey.
                This usually takes a few seconds.
              </p>
              <button
                type="button"
                className="btn-primary mt-4"
                onClick={() => void runPlan()}
                disabled={planning}
              >
                {planning ? 'Searching providers…' : 'Build my plans'}
              </button>
            </section>
          ) : null}

          {planResult ? (
            <TransportComparison
              modes={planResult.comparison.outbound.modes}
              filtered={planResult.comparison.outbound.filteredByYourRequirements}
              timezone={trip.classification.originTimezone}
            />
          ) : null}

          <PlanCards plans={plans} selectedId={selectedPlan?.id ?? null} onSelect={(p) => void selectPlan(p)} />

          {selectedPlan ? (
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
              <div className="space-y-6">
                {selectedPlan.hotels[0] ? <StayCard plan={selectedPlan} /> : null}
                <ItineraryTimeline plan={selectedPlan} />
              </div>
              <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
                <BudgetPanel
                  plan={selectedPlan}
                  conflict={planResult?.budgetConflict ?? null}
                  onApply={(utterance) => void modify(utterance)}
                />
                <ModifyBar
                  busy={busy}
                  lastResult={lastModification}
                  onSubmit={(utterance) => void modify(utterance)}
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

function StayCard({ plan }: { plan: TripPlan }) {
  const stay = plan.hotels[0];
  if (!stay) return null;

  return (
    <section className="card p-5">
      <h2 className="font-display text-xl tracking-tight">Where you stay</h2>
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
