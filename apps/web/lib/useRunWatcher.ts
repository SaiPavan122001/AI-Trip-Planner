'use client';

import { useEffect, useRef } from 'react';
import { ApiClientError, api, isActiveRun, type PlanningRun } from '@/lib/api';

/**
 * Follows a background search until it ends.
 *
 * It polls, with gentle backoff, rather than holding a connection open: a
 * search can outlast a phone's mobile-data hiccup or a laptop lid, and a
 * traveller who comes back to the tab simply picks up the run's current
 * state. Because the run lives on the server, a page reload loses nothing.
 */
export function useRunWatcher(
  tripId: string,
  run: PlanningRun | null,
  onUpdate: (run: PlanningRun) => void,
  onLost: (message: string) => void,
): void {
  // The latest callbacks, without restarting the poll each time they change.
  const update = useRef(onUpdate);
  const lost = useRef(onLost);
  useEffect(() => {
    update.current = onUpdate;
    lost.current = onLost;
  });

  const runId = run?.id ?? null;
  const active = isActiveRun(run);

  useEffect(() => {
    if (!runId || !active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = 700;
    let failures = 0;

    const poll = async () => {
      try {
        const { run: latest } = await api.getRun(tripId, runId);
        if (stopped) return;
        failures = 0;
        update.current(latest);
        if (isActiveRun(latest)) {
          delay = Math.min(delay * 1.3, 2500);
          timer = setTimeout(() => void poll(), delay);
        }
      } catch (err) {
        if (stopped) return;
        // The trip or the run is gone (deleted, or signed out): nothing to wait for.
        if (err instanceof ApiClientError && (err.status === 404 || err.status === 401)) {
          lost.current('This search is no longer available.');
          return;
        }
        failures += 1;
        if (failures >= 6) {
          lost.current('The connection to the planning service was lost. Reload to see where the search got to.');
          return;
        }
        timer = setTimeout(() => void poll(), 3000);
      }
    };

    timer = setTimeout(() => void poll(), delay);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [tripId, runId, active]);
}
