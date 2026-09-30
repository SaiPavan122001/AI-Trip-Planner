'use client';

import type { PlanningRun } from '@/lib/api';

/**
 * Where a background search has got to, in words. The percentage is the
 * planner's own count of its steps, not a promise about time: providers vary,
 * so the bar shows progress through the work and the text says what is being
 * done.
 */
export function PlanningProgress({
  run,
  onCancel,
  cancelling,
}: {
  run: PlanningRun;
  onCancel: () => void;
  cancelling: boolean;
}) {
  const waiting = run.status === 'queued';
  const percent = run.progress?.percent ?? (waiting ? 2 : 5);
  const label = run.cancelRequested
    ? 'Stopping the search…'
    : waiting
      ? 'Waiting for a search slot…'
      : (run.progress?.label ?? 'Starting the search');

  return (
    <section className="card p-6" aria-live="polite" aria-busy="true">
      <h2 className="font-display text-xl tracking-tight">
        {run.kind === 'replan' ? 'Updating your plans' : 'Building your plans'}
      </h2>
      <p className="mt-2 text-sm text-ink-soft">
        {label}. You can leave this page open, or come back later: the search carries on without you.
      </p>
      <div
        className="mt-4 h-2 overflow-hidden rounded-full bg-sand-200"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label="Search progress"
      >
        <div className="h-full rounded-full bg-teal-500 transition-all duration-500" style={{ width: `${percent}%` }} />
      </div>
      <button
        type="button"
        className="btn-ghost mt-4"
        onClick={onCancel}
        disabled={cancelling || run.cancelRequested}
      >
        {run.cancelRequested || cancelling ? 'Stopping…' : 'Stop searching'}
      </button>
    </section>
  );
}
