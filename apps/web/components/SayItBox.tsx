'use client';

import { useState } from 'react';
import { ApiClientError, api, type RequirementsReply, type TripSession } from '@/lib/api';

/**
 * "Tell me more, in your own words."
 *
 * What you write is read by the planner, checked, and applied through the same
 * answers the questions collect, so nothing gets in that a question would have
 * refused. The reply says plainly what was used, what could not be, and what
 * only the change flow (which asks first) can do, such as new dates.
 */
export function SayItBox({
  tripId,
  disabled,
  onTrip,
}: {
  tripId: string;
  disabled: boolean;
  onTrip: (trip: TripSession) => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<RequirementsReply | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    api
      .sayInWords(tripId, text.trim())
      .then((result) => {
        setReply(result);
        onTrip(result.trip);
        setText('');
      })
      .catch((err) => setError(err instanceof ApiClientError ? err.message : 'That could not be read.'))
      .finally(() => setBusy(false));
  };

  return (
    <section className="card p-5">
      <h2 className="font-display text-xl tracking-tight">Tell me more, in your own words</h2>
      <p className="mt-1 text-sm text-ink-soft">
        For example: &ldquo;We would like a relaxed pace with lots of history, no overnight travel, and the budget is a firm ₹80,000.&rdquo;
      </p>
      <form className="mt-4 space-y-3" onSubmit={submit}>
        <textarea
          className="field min-h-[5rem] w-full"
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={2000}
          aria-label="Describe what you would like"
          disabled={disabled || busy}
        />
        <button type="submit" className="btn-primary" disabled={disabled || busy || !text.trim()}>
          {busy ? 'Reading…' : 'Use this'}
        </button>
      </form>

      {error ? (
        <p role="alert" className="mt-3 text-sm text-clay">
          {error}
        </p>
      ) : null}

      {reply ? (
        <div className="mt-4 space-y-2 rounded-xl bg-sand-100 px-4 py-3 text-sm" aria-live="polite">
          {reply.conflicts.length > 0 ? (
            <div className="text-clay">
              <p className="font-medium">Some of that contradicts itself, so none of it was applied:</p>
              <ul className="list-disc pl-5">{reply.conflicts.map((c) => <li key={c.message}>{c.message}</li>)}</ul>
            </div>
          ) : null}
          {reply.applied.length > 0 ? <p>Used: {reply.applied.map((k) => k.replace(/[._]/g, ' ')).join(', ')}.</p> : null}
          {reply.keptForPlanning.length > 0 ? (
            <p>Kept for your next search: {reply.keptForPlanning.join('; ')}.</p>
          ) : null}
          {reply.rejected.map((r) => (
            <p key={r.key} className="text-clay">Could not use {r.key.replace(/[._]/g, ' ')}: {r.reason}</p>
          ))}
          {reply.unmapped.map((u) => (
            <p key={u.item} className="text-ink-soft">{u.item}: {u.reason}</p>
          ))}
          {reply.differences.length > 0 ? (
            <div className="text-ink-soft">
              <p className="font-medium">These differ from your trip, so nothing was changed:</p>
              <ul className="list-disc pl-5">
                {reply.differences.map((d) => (
                  <li key={d.field}>{d.field}: you said {d.said}, the trip has {d.current}. Use &ldquo;Change something&rdquo; to change it, and you will be asked first.</li>
                ))}
              </ul>
            </div>
          ) : null}
          {reply.applied.length === 0 && reply.conflicts.length === 0 && reply.keptForPlanning.length === 0 && reply.unmapped.length === 0 && reply.differences.length === 0 ? (
            <p>Nothing in that could be used yet. Try saying what you want and what you cannot do.</p>
          ) : null}
          <p className="text-[11px] text-ink-faint">
            Read by {reply.understoodBy === 'rules' ? 'the planner’s built-in rules' : reply.understoodBy}.
            {reply.droppedCount > 0 ? ` ${reply.droppedCount} suggestion(s) were left out because they did not match your words.` : ''}
          </p>
        </div>
      ) : null}
    </section>
  );
}
