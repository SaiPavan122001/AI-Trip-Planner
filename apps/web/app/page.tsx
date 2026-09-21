import Link from 'next/link';
import { JourneyForm } from '@/components/JourneyForm';

/**
 * The landing page makes one promise and then immediately lets you test it:
 * the form is the first thing on the screen, because a travel product that
 * makes you scroll past marketing to reach the search box has its priorities
 * the wrong way round.
 */
export default function HomePage() {
  return (
    <>
      <section className="relative overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_70%_-10%,rgba(15,107,96,0.14),transparent_70%)]"
        />
        <div className="relative mx-auto grid w-full max-w-6xl gap-10 px-4 pb-16 pt-12 sm:px-6 lg:grid-cols-[1.05fr_1fr] lg:gap-14 lg:pt-20">
          <div className="max-w-xl">
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-teal-500">
              Open-source trip planning
            </p>
            <h1 className="mt-4 font-display text-4xl leading-[1.1] tracking-tight sm:text-5xl">
              A plan that survives contact with the real trip.
            </h1>
            <p className="mt-5 text-lg leading-relaxed text-ink-soft">
              Tell it where you are going and what actually matters to you. It works out whether
              this is a flight problem or a train problem, searches real providers, and builds the
              whole journey — transfers, check-in times, the hour you lose at the airport — then
              tells you what it costs in total.
            </p>

            <dl className="mt-8 grid gap-5 sm:grid-cols-2">
              <Feature title="Nothing invented">
                Prices, schedules and availability come from connected providers, each labelled
                with its source and retrieval time. Missing data is reported, never filled in.
              </Feature>
              <Feature title="Total cost, not sticker price">
                A room that is cheaper but twenty minutes further out is priced with the taxis it
                forces on you.
              </Feature>
              <Feature title="Your ranking, not ours">
                Cheapest, fastest, fewest changes, safest arrival — you order them, and every plan
                explains where it sits against that order.
              </Feature>
              <Feature title="Hard limits stay hard">
                Your budget, dates, room count and accessibility needs are filters, not
                suggestions. Nothing is quietly relaxed to make a plan fit.
              </Feature>
            </dl>
          </div>

          <div className="lg:pt-10">
            <JourneyForm />
            <p className="mt-4 text-center text-xs text-ink-faint">
              Running this yourself?{' '}
              <Link href="/sources" className="underline hover:text-ink">
                See which providers are connected
              </Link>{' '}
              — the planner works with none of them and tells you exactly what it cannot search.
            </p>
          </div>
        </div>
      </section>

      <section className="border-t border-sand-200 bg-white">
        <div className="mx-auto w-full max-w-6xl px-4 py-14 sm:px-6">
          <h2 className="font-display text-2xl tracking-tight">How a trip gets built</h2>
          <ol className="mt-8 grid gap-6 md:grid-cols-3">
            <Step n="01" title="The journey decides the options">
              Hyderabad to Warangal and Hyderabad to Paris are different problems. The planner
              classifies the journey first, then only searches the modes that make sense — and
              names the ones it ruled out, with the reason.
            </Step>
            <Step n="02" title="Questions that change the answer">
              One at a time, and only when they matter. A solo business traveller is never asked
              about cots; nobody is asked about rail classes on a route with no trains.
            </Step>
            <Step n="03" title="Whole-trip optimisation">
              Transport, room, transfers, opening hours, buffer time and daily spending are solved
              together, then validated: no impossible connections, no museum on its closing day.
            </Step>
          </ol>
        </div>
      </section>
    </>
  );
}

function Feature({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-sm font-semibold">{title}</dt>
      <dd className="mt-1 text-sm leading-relaxed text-ink-soft">{children}</dd>
    </div>
  );
}

function Step({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <li className="card p-5">
      <span className="font-display text-sm text-teal-500">{n}</span>
      <h3 className="mt-2 text-base font-semibold">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-ink-soft">{children}</p>
    </li>
  );
}
