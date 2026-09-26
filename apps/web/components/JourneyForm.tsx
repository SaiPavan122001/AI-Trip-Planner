'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { SUPPORTED_CURRENCY } from '@trip/shared/currency';
import { ApiClientError, api } from '@/lib/api';

/**
 * The first screen, and deliberately the only thing asked up front: where
 * from, where to, when, and how many. Everything else depends on knowing
 * whether this journey is domestic or international, and that cannot be
 * decided until these five answers exist.
 */

const today = () => new Date().toISOString().slice(0, 10);

export function JourneyForm() {
  const router = useRouter();
  const [origin, setOrigin] = useState('');
  const [destination, setDestination] = useState('');
  const [departureDate, setDepartureDate] = useState('');
  const [returnDate, setReturnDate] = useState('');
  const [oneWay, setOneWay] = useState(false);
  const [adults, setAdults] = useState(1);
  const [children, setChildren] = useState(0);
  const [infants, setInfants] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { trip } = await api.createTrip({
        originQuery: origin.trim(),
        destinationQuery: destination.trim(),
        departureDate,
        returnDate: oneWay ? null : returnDate || null,
        travelers: { adults, children, infants },
        currency: SUPPORTED_CURRENCY,
      });
      router.push(`/trips/${trip.id}`);
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : 'Something went wrong starting this trip.',
      );
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="card p-5 sm:p-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="origin">
            Travelling from
          </label>
          <input
            id="origin"
            className="field"
            required
            value={origin}
            onChange={(e) => setOrigin(e.target.value)}
            placeholder="Hyderabad, India"
            autoComplete="off"
          />
        </div>
        <div>
          <label className="label" htmlFor="destination">
            Travelling to
          </label>
          <input
            id="destination"
            className="field"
            required
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            placeholder="Paris, France"
            autoComplete="off"
          />
        </div>

        <div>
          <label className="label" htmlFor="departure">
            Departure
          </label>
          <input
            id="departure"
            type="date"
            className="field"
            required
            min={today()}
            value={departureDate}
            onChange={(e) => setDepartureDate(e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="return">
            Return
          </label>
          <input
            id="return"
            type="date"
            className="field disabled:bg-sand-100 disabled:text-ink-faint"
            min={departureDate || today()}
            value={returnDate}
            disabled={oneWay}
            onChange={(e) => setReturnDate(e.target.value)}
          />
          <label className="mt-2 flex items-center gap-2 text-xs text-ink-soft">
            <input
              type="checkbox"
              checked={oneWay}
              onChange={(e) => setOneWay(e.target.checked)}
              className="rounded border-sand-300"
            />
            One way — no return leg or accommodation
          </label>
        </div>
      </div>

      <fieldset className="mt-5 border-t border-sand-200 pt-5">
        <legend className="sr-only">Travellers</legend>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Counter label="Adults" value={adults} min={1} onChange={setAdults} />
          <Counter label="Children" value={children} min={0} onChange={setChildren} />
          <Counter label="Infants" value={infants} min={0} onChange={setInfants} />
          <div>
            <span className="label">Currency</span>
            <p className="field bg-sand-50 text-ink-soft">₹ Indian rupees</p>
          </div>
        </div>
      </fieldset>

      {error ? (
        <p role="alert" className="mt-4 rounded-xl bg-clay/10 px-4 py-3 text-sm text-clay">
          {error}
        </p>
      ) : null}

      <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-ink-faint">
          Next, a few questions that actually change the plan. No sign-up needed.
        </p>
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Working out the route…' : 'Start planning'}
        </button>
      </div>
    </form>
  );
}

function Counter({
  label,
  value,
  min,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  onChange: (n: number) => void;
}) {
  return (
    <div>
      <span className="label">{label}</span>
      <div className="flex items-center rounded-xl border border-sand-300 bg-white">
        <button
          type="button"
          className="px-3 py-2.5 text-ink-faint transition hover:text-ink disabled:opacity-40"
          onClick={() => onChange(Math.max(min, value - 1))}
          disabled={value <= min}
          aria-label={`One fewer ${label.toLowerCase()}`}
        >
          −
        </button>
        <span className="flex-1 text-center text-sm tabular-nums">{value}</span>
        <button
          type="button"
          className="px-3 py-2.5 text-ink-faint transition hover:text-ink"
          onClick={() => onChange(Math.min(20, value + 1))}
          aria-label={`One more ${label.toLowerCase()}`}
        >
          +
        </button>
      </div>
    </div>
  );
}
