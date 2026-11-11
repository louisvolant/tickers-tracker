import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isWatchlistPollingActive,
  WATCHLIST_IDLE_TIMEOUT_MS,
} from '../src/lib/polling';

const NOW = Date.UTC(2026, 10, 11, 10, 0);

const gate = (overrides: Partial<Parameters<typeof isWatchlistPollingActive>[0]> = {}) =>
  isWatchlistPollingActive({
    now: NOW,
    lastActivityAt: NOW - 1_000,
    visible: true,
    online: true,
    ...overrides,
  });

describe('Watchlist polling gate', () => {
  test('polls while the tab is visible, online and recently active', () => {
    assert.equal(gate(), true);
  });

  test('never polls in a hidden tab, even right after an interaction', () => {
    assert.equal(gate({ visible: false, lastActivityAt: NOW }), false);
  });

  test('never polls while offline', () => {
    assert.equal(gate({ online: false, lastActivityAt: NOW }), false);
  });

  test('stops once the idle timeout is reached', () => {
    assert.equal(gate({ lastActivityAt: NOW - WATCHLIST_IDLE_TIMEOUT_MS + 1 }), true);
    assert.equal(gate({ lastActivityAt: NOW - WATCHLIST_IDLE_TIMEOUT_MS }), false);
    assert.equal(gate({ lastActivityAt: NOW - WATCHLIST_IDLE_TIMEOUT_MS - 1 }), false);
  });

  test('honours a custom idle timeout', () => {
    assert.equal(gate({ lastActivityAt: NOW - 30_000, idleTimeoutMs: 60_000 }), true);
    assert.equal(gate({ lastActivityAt: NOW - 90_000, idleTimeoutMs: 60_000 }), false);
  });

  test('treats a missing activity timestamp as idle', () => {
    assert.equal(gate({ lastActivityAt: Number.NaN }), false);
  });
});
