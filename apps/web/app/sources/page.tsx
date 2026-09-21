'use client';

import { useEffect, useState } from 'react';
import { ApiClientError, api, type ProvidersResponse } from '@/lib/api';

/**
 * Data sources, shown to travellers rather than buried in a README.
 *
 * A planner that claims never to invent data has to make it easy to check
 * which sources are actually live. This page is that check.
 */
export default function SourcesPage() {
  const [data, setData] = useState<ProvidersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .providers()
      .then(setData)
      .catch((err) =>
        setError(
          err instanceof ApiClientError
            ? err.message
            : 'The provider list could not be loaded.',
        ),
      );
  }, []);

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6">
      <h1 className="font-display text-3xl tracking-tight">Where the data comes from</h1>

      {error ? (
        <p role="alert" className="mt-5 rounded-xl bg-clay/10 px-4 py-3 text-sm text-clay">
          {error}
        </p>
      ) : null}

      {data ? (
        <>
          <p className="mt-4 max-w-2xl leading-relaxed text-ink-soft">{data.dataPolicy}</p>

          <section className="mt-8">
            <h2 className="font-display text-xl tracking-tight">Connected</h2>
            {data.configured.length === 0 ? (
              <p className="mt-2 text-sm text-ink-soft">
                No providers are connected. The planner can still classify a journey and interview
                you, but it has nothing to search.
              </p>
            ) : (
              <ul className="mt-4 grid gap-3 sm:grid-cols-2">
                {data.configured.map((p) => (
                  <li key={p.id} className="card p-4">
                    <h3 className="text-sm font-semibold">{p.label}</h3>
                    <p className="mt-1 text-xs capitalize text-ink-faint">
                      {p.kinds.map((k) => k.replace(/_/g, ' ')).join(' · ')}
                    </p>
                    {p.attribution ? (
                      <p className="mt-2 text-[11px] text-ink-faint">{p.attribution}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {data.disabled.length > 0 ? (
            <section className="mt-8">
              <h2 className="font-display text-xl tracking-tight">Not connected</h2>
              <p className="mt-1 text-sm text-ink-soft">
                These are adapters this build ships with, waiting on credentials. Nothing below is
                being estimated in their place.
              </p>
              <ul className="mt-4 space-y-3">
                {data.disabled.map((p) => (
                  <li key={p.id} className="card p-4">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <h3 className="text-sm font-semibold">{p.label}</h3>
                      <code className="rounded bg-sand-100 px-2 py-0.5 text-[11px] text-ink-soft">
                        {p.requiredEnv.join(', ')}
                      </code>
                    </div>
                    <p className="mt-2 text-sm text-ink-soft">{p.reason}</p>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="mt-8 card p-5">
            <h2 className="text-sm font-semibold">Language understanding</h2>
            <p className="mt-2 text-sm text-ink-soft">
              {data.llm.available
                ? `${data.llm.label} is used to interpret what you type when changing a plan. It never sources a price, schedule or availability: those come only from the providers above, and every plan is validated by deterministic rules afterwards.`
                : 'No language model is configured. Plain-language changes fall back to keyword rules, which are blunter but entirely predictable. Planning itself is unaffected, because it never used a model.'}
            </p>
          </section>
        </>
      ) : !error ? (
        <p className="mt-6 text-sm text-ink-faint">Checking which providers are live…</p>
      ) : null}
    </div>
  );
}
