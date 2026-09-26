'use client';

import { useState } from 'react';
import type { ModifyResponse, TripSession } from '@/lib/api';

/**
 * Conversational modification.
 *
 * The response always states what was understood and which parts of the plan
 * were re-searched versus carried over untouched. That readback is the whole
 * trust mechanism: a traveller who asked to keep their hotel needs to see
 * that the hotel was kept, or why it could not be.
 *
 * When a change needs the traveller's say-so, the question is shown with its
 * two answers, and nothing changes until one is chosen.
 */

const SUGGESTIONS = [
  'Make it cheaper',
  'Use the train instead',
  'I want a nicer hotel',
  'No overnight travel',
  'Prioritise safety over price',
  'Make it cheaper but keep the hotel',
];

const COMPONENT_LABEL: Record<string, string> = {
  outbound: 'outbound journey',
  return: 'return journey',
  hotel: 'hotel',
  transfers: 'transfers',
  activities: 'activities',
};

const label = (c: string) => COMPONENT_LABEL[c] ?? c;

export function ModifyBar({
  busy,
  lastResult,
  pending,
  onSubmit,
  onAnswer,
}: {
  busy: boolean;
  lastResult: ModifyResponse | null;
  /** The trip's stored question, so it is still shown after a reload. */
  pending: TripSession['pendingModification'];
  onSubmit: (utterance: string) => void;
  onAnswer: (pendingModificationId: string, accept: boolean) => void;
}) {
  const [value, setValue] = useState('');
  const waiting = pending;

  return (
    <section className="card p-5">
      <h2 className="font-display text-xl tracking-tight">Change something</h2>
      <p className="mt-1 text-sm text-ink-soft">
        Say it in your own words. Only the parts affected are searched again, and anything you ask
        to keep stays exactly as it is.
      </p>

      <form
        className="mt-4 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!value.trim()) return;
          onSubmit(value.trim());
          setValue('');
        }}
      >
        <input
          className="field flex-1 min-w-[16rem]"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Make it cheaper, but keep the hotel"
          aria-label="Describe the change you want"
          maxLength={500}
        />
        <button type="submit" className="btn-primary" disabled={busy || !value.trim()}>
          {busy ? 'Working…' : 'Apply'}
        </button>
      </form>

      <div className="mt-3 flex flex-wrap gap-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            disabled={busy}
            onClick={() => onSubmit(s)}
            className="rounded-full border border-sand-300 bg-white px-3 py-1.5 text-xs text-ink-soft transition hover:border-ink-faint hover:text-ink disabled:opacity-50"
          >
            {s}
          </button>
        ))}
      </div>

      {lastResult || waiting ? (
        <div className="mt-4 rounded-xl bg-sand-100 px-4 py-3" aria-live="polite">
          {lastResult ? <p className="text-sm">{lastResult.interpretation}</p> : null}

          {waiting ? (
            <div className="mt-3 rounded-lg bg-white px-3 py-3" role="group" aria-label="Confirm this change">
              <p className="text-sm font-medium text-ink">{waiting.question}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn-primary"
                  disabled={busy}
                  onClick={() => onAnswer(waiting.id, true)}
                >
                  {waiting.acceptLabel}
                </button>
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={busy}
                  onClick={() => onAnswer(waiting.id, false)}
                >
                  {waiting.declineLabel}
                </button>
              </div>
            </div>
          ) : null}

          {lastResult && lastResult.released.length > 0 ? (
            <ul className="mt-2 space-y-1 text-xs text-clay">
              {lastResult.released.map((r) => (
                <li key={r.component}>{r.reason}</li>
              ))}
            </ul>
          ) : null}

          {lastResult?.status === 'applied' ? (
            <p className="mt-1.5 text-[11px] text-ink-faint">
              {lastResult.understoodBy ? `Understood by ${lastResult.understoodBy} · ` : ''}
              {lastResult.reSearched.length > 0
                ? `searched again: ${lastResult.reSearched.map(label).join(', ')}`
                : 'nothing was searched again'}
              {lastResult.kept.length > 0 ? ` · kept: ${lastResult.kept.map(label).join(', ')}` : ''}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
