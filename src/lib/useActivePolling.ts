'use client';

// Active-only polling.
//
// The interval is created only while the gate is open (visible tab, online,
// recent interaction) and torn down when it closes, so a background or idle tab
// performs no requests at all. When the gate reopens the callback runs once
// immediately: coming back to the app should show current prices, not the ones
// from when it was left.
import { useEffect, useRef, useState } from 'react';
import {
  isWatchlistPollingActive,
  WATCHLIST_IDLE_TIMEOUT_MS,
  WATCHLIST_POLL_INTERVAL_MS,
} from './polling';

/** Events that prove a human is still in front of the app. */
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'scroll', 'touchstart'] as const;

/** How often the gate is re-evaluated while nothing happens. */
const GATE_CHECK_MS = 15_000;

export interface ActivePollingOptions {
  /** Set to false to keep the gate closed (e.g. an empty watchlist). */
  enabled?: boolean;
  intervalMs?: number;
  idleTimeoutMs?: number;
}

export function useActivePolling(
  onPoll: () => void | Promise<void>,
  options: ActivePollingOptions = {}
): void {
  const {
    enabled = true,
    intervalMs = WATCHLIST_POLL_INTERVAL_MS,
    idleTimeoutMs = WATCHLIST_IDLE_TIMEOUT_MS,
  } = options;

  const callbackRef = useRef(onPoll);
  const lastActivityRef = useRef<number>(Date.now());
  const hasPolledRef = useRef(false);
  const pausedRef = useRef(false);
  const inFlightRef = useRef(false);
  const [active, setActive] = useState(false);

  useEffect(() => {
    callbackRef.current = onPoll;
  }, [onPoll]);

  // Track activity, visibility and connectivity, and keep the gate up to date.
  useEffect(() => {
    if (!enabled) {
      setActive(false);
      return;
    }

    let cancelled = false;

    const gate = () => {
      if (cancelled) return;
      setActive(
        isWatchlistPollingActive({
          now: Date.now(),
          lastActivityAt: lastActivityRef.current,
          visible: document.visibilityState === 'visible',
          online: navigator.onLine,
          idleTimeoutMs,
        })
      );
    };

    const markActivity = () => {
      lastActivityRef.current = Date.now();
      gate();
    };

    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, markActivity, { passive: true });
    }
    window.addEventListener('online', gate);
    window.addEventListener('offline', gate);
    document.addEventListener('visibilitychange', gate);

    // Only timer that is always running: it closes the gate once the idle
    // timeout elapses without input. It never performs a request.
    const idleCheck = window.setInterval(gate, Math.min(GATE_CHECK_MS, idleTimeoutMs));
    markActivity();

    return () => {
      cancelled = true;
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, markActivity);
      }
      window.removeEventListener('online', gate);
      window.removeEventListener('offline', gate);
      document.removeEventListener('visibilitychange', gate);
      window.clearInterval(idleCheck);
    };
  }, [enabled, idleTimeoutMs]);

  // The request interval only exists while the gate is open.
  useEffect(() => {
    if (!enabled || !active) {
      pausedRef.current = true;
      return;
    }

    const poll = () => {
      // A slow refresh must not stack: skip the tick instead of overlapping.
      if (inFlightRef.current) return;
      hasPolledRef.current = true;
      const result = callbackRef.current();
      if (result && typeof (result as Promise<void>).then === 'function') {
        inFlightRef.current = true;
        void (result as Promise<void>).finally(() => {
          inFlightRef.current = false;
        });
      }
    };

    // Reopened gate: refresh now instead of waiting a full interval.
    if (pausedRef.current && hasPolledRef.current) poll();
    pausedRef.current = false;

    const id = window.setInterval(poll, intervalMs);
    return () => {
      pausedRef.current = true;
      window.clearInterval(id);
    };
  }, [enabled, active, intervalMs]);
}
