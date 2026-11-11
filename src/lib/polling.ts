// Watchlist auto-refresh gate.
//
// Quotes must only be polled while somebody is actually looking at them: a
// background tab, a phone in a pocket or a forgotten desktop tab must not keep
// spending Yahoo requests every 30 seconds. The policy is a pure function so it
// can be unit-tested without a DOM.

/** How often the watchlist refreshes while it is being watched. */
export const WATCHLIST_POLL_INTERVAL_MS = 30_000;

/** No interaction for this long means the user walked away: stop polling. */
export const WATCHLIST_IDLE_TIMEOUT_MS = 5 * 60_000;

export interface PollingGateInput {
  now: number;
  /** Epoch ms of the last pointer/keyboard/scroll/touch interaction. */
  lastActivityAt: number;
  /** `document.visibilityState === 'visible'`. */
  visible: boolean;
  /** `navigator.onLine`. */
  online: boolean;
  idleTimeoutMs?: number;
}

/**
 * Whether the watchlist should refresh right now.
 *
 * All three conditions are required: the tab is visible, the browser is online,
 * and the user interacted recently enough. Any of them failing stops polling
 * completely rather than merely skipping a tick.
 */
export function isWatchlistPollingActive({
  now,
  lastActivityAt,
  visible,
  online,
  idleTimeoutMs = WATCHLIST_IDLE_TIMEOUT_MS,
}: PollingGateInput): boolean {
  if (!visible || !online) return false;
  if (!Number.isFinite(lastActivityAt)) return false;
  return now - lastActivityAt < idleTimeoutMs;
}
