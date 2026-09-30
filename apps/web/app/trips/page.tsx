'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ApiClientError, api, safeHttpLink, type Me, type TripSummary } from '@/lib/api';

/**
 * A traveller's own trips, and their account.
 *
 * Everyone who plans has a private session in this browser, so their trips
 * are listed here whether or not they have signed in. Signing in by emailed
 * link is how those trips follow them to another device; it needs no
 * password and adds an email to the account they already have.
 */
export default function SavedTripsPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [trips, setTrips] = useState<TripSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    () =>
      Promise.all([api.me(), api.listTrips()])
        .then(([who, list]) => {
          setMe(who);
          setTrips(list.trips);
          setError(null);
        })
        .catch((err) =>
          setError(err instanceof ApiClientError ? err.message : 'Your trips could not be loaded.'),
        ),
    [],
  );

  useEffect(() => {
    load();
  }, [load]);

  const remove = async (id: string) => {
    try {
      await api.deleteTrip(id);
      setTrips((current) => current?.filter((t) => t.id !== id) ?? null);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'That trip could not be deleted.');
    }
  };

  const signedIn = Boolean(me?.user && !me.user.isAnonymous);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6">
      <h1 className="font-display text-3xl tracking-tight">Your trips</h1>

      {error ? (
        <p role="alert" className="mt-5 rounded-xl bg-clay/10 px-4 py-3 text-sm text-clay">
          {error}
        </p>
      ) : null}

      {trips === null && !error ? <p className="mt-6 text-ink-faint">Loading…</p> : null}

      {trips && trips.length === 0 ? (
        <p className="mt-4 leading-relaxed text-ink-soft">
          Nothing planned yet. Trips you plan appear here, and stay private to you.
        </p>
      ) : null}

      {trips && trips.length > 0 ? (
        <ul className="mt-6 space-y-3">
          {trips.map((trip) => (
            <li key={trip.id} className="card flex flex-wrap items-center justify-between gap-3 p-4">
              <Link href={`/trips/${trip.id}`} className="min-w-0 flex-1">
                <span className="block font-medium">
                  {trip.origin} → {trip.destination}
                </span>
                <span className="block text-sm text-ink-soft">
                  {trip.departureDate}
                  {trip.returnDate ? ` to ${trip.returnDate}` : ' · one way'} ·{' '}
                  {trip.planCount > 0 ? `${trip.planCount} plans` : 'not searched yet'}
                </span>
              </Link>
              <button type="button" className="btn-ghost text-sm" onClick={() => void remove(trip.id)}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <Link href="/" className="btn-primary mt-8">
        Plan a new trip
      </Link>

      {me ? (signedIn ? <AccountSection me={me} onGone={load} /> : <SignIn me={me} />) : null}
    </div>
  );
}

function SignIn({ me }: { me: Me }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<{ message: string; devLink?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!me.emailSignIn) {
    return (
      <section className="mt-12 border-t border-sand-200 pt-8">
        <h2 className="font-display text-xl tracking-tight">Keeping your trips</h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">
          Your trips are saved in this browser. Signing in by email is not set up on this server, so
          use the same browser to come back to them.
        </p>
      </section>
    );
  }

  return (
    <section className="mt-12 border-t border-sand-200 pt-8">
      <h2 className="font-display text-xl tracking-tight">Keep your trips on any device</h2>
      <p className="mt-2 text-sm leading-relaxed text-ink-soft">
        Enter your email and we will send a link that signs you in. No password. The trips you have
        planned here come with you.
      </p>
      {sent ? (
        <div className="mt-4 rounded-xl bg-teal-500/[0.08] px-4 py-3 text-sm text-teal-700" role="status">
          <p>{sent.message}</p>
          {safeHttpLink(sent.devLink) ? (
            <p className="mt-2 break-all">
              Development only:{' '}
              <a className="underline" href={safeHttpLink(sent.devLink) ?? undefined}>
                open the link
              </a>
            </p>
          ) : null}
        </div>
      ) : (
        <form
          className="mt-4 flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            api
              .requestSignInLink(email.trim())
              .then(setSent)
              .catch((err) =>
                setError(err instanceof ApiClientError ? err.message : 'The link could not be sent.'),
              )
              .finally(() => setBusy(false));
          }}
        >
          <input
            className="field min-w-[16rem] flex-1"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            aria-label="Your email address"
          />
          <button type="submit" className="btn-primary" disabled={busy || !email.trim()}>
            {busy ? 'Sending…' : 'Email me a link'}
          </button>
        </form>
      )}
      {error ? (
        <p role="alert" className="mt-3 text-sm text-clay">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function AccountSection({ me, onGone }: { me: Me; onGone: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = (action: () => Promise<unknown>, failure: string) => {
    setError(null);
    action()
      .then(onGone)
      .catch((err) => setError(err instanceof ApiClientError ? err.message : failure));
  };

  return (
    <section className="mt-12 border-t border-sand-200 pt-8">
      <h2 className="font-display text-xl tracking-tight">Your account</h2>
      <p className="mt-2 text-sm text-ink-soft">Signed in as {me.user?.email}.</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <a className="btn-ghost" href={api.exportUrl}>
          Download my data
        </a>
        <button type="button" className="btn-ghost" onClick={() => run(() => api.signOut(), 'Signing out failed.')}>
          Sign out
        </button>
      </div>

      <div className="mt-6 rounded-xl bg-clay/[0.06] p-4">
        <h3 className="text-sm font-semibold">Delete my account</h3>
        <p className="mt-1 text-xs leading-relaxed text-ink-soft">
          This removes your account and every trip, plan and sign-in that belongs to it. It cannot
          be undone.
        </p>
        {confirming ? (
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-primary"
              onClick={() => run(() => api.deleteAccount(), 'The account could not be deleted.')}
            >
              Yes, delete everything
            </button>
            <button type="button" className="btn-ghost" onClick={() => setConfirming(false)}>
              Keep my account
            </button>
          </div>
        ) : (
          <button type="button" className="btn-ghost mt-3" onClick={() => setConfirming(true)}>
            Delete my account…
          </button>
        )}
        {error ? (
          <p role="alert" className="mt-3 text-sm text-clay">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
