'use client';

import { useState } from 'react';

/**
 * Conversational modification.
 *
 * The response always states what was understood and which parts of the plan
 * were re-searched versus carried over untouched. That readback is the whole
 * trust mechanism: a traveller who asked to keep their hotel needs to see
 * that the hotel was kept.
 */

const SUGGESTIONS = [
  'Make it cheaper',
  'Use the train instead',
  'I want a nicer hotel',
  'No overnight travel',
  'Prioritise safety over price',
  'Keep the hotel but change the flight',
];

export function ModifyBar({
  busy,
  lastResult,
  onSubmit,
}: {
  busy: boolean;
  lastResult: {
    interpretation: string;
    understoodBy: string;
    reSearched: string[];
    preserved: string[];
    requiresConsent: { constraint: string; question: string } | null;
  } | null;
  onSubmit: (utterance: string) => void;
}) {
  const [value, setValue] = useState('');

  return (
    <section className="card p-5">
      <h2 className="font-display text-xl tracking-tight">Change something</h2>
      <p className="mt-1 text-sm text-ink-soft">
        Say it in your own words. Only the parts affected are searched again.
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
          {busy ? 'Re-planning…' : 'Apply'}
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

      {lastResult ? (
        <div className="mt-4 rounded-xl bg-sand-100 px-4 py-3">
          <p className="text-sm">{lastResult.interpretation}</p>
          <p className="mt-1.5 text-[11px] text-ink-faint">
            Understood by {lastResult.understoodBy}
            {lastResult.reSearched.length > 0
              ? ` · searched again: ${lastResult.reSearched.join(', ')}`
              : ' · nothing was re-searched'}
            {lastResult.preserved.length > 0 ? ` · kept: ${lastResult.preserved.join(', ')}` : ''}
          </p>
          {lastResult.requiresConsent ? (
            <p className="mt-2 rounded-lg bg-white px-3 py-2 text-sm text-clay">
              {lastResult.requiresConsent.question}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
