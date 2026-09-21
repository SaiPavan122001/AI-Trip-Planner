import Link from 'next/link';

/**
 * Saved trips. Planning is anonymous by default, so this page explains where
 * a trip actually lives rather than pretending to a list it cannot have.
 */
export default function SavedTripsPage() {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-16 sm:px-6">
      <h1 className="font-display text-3xl tracking-tight">Saved trips</h1>
      <p className="mt-4 leading-relaxed text-ink-soft">
        Trips are not tied to an account here: you can plan a whole journey without signing up,
        and the link to a trip is what opens it again. Keep the link and you keep the trip.
      </p>
      <p className="mt-3 leading-relaxed text-ink-soft">
        A deployment that has accounts enabled lists a traveller&rsquo;s own trips on this page
        once they are signed in.
      </p>
      <Link href="/" className="btn-primary mt-8">
        Plan a new trip
      </Link>
    </div>
  );
}
