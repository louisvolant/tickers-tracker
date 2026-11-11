import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  NO_EXTENDED_SESSION,
  applyExtendedSession,
  extendedSessionNeedsChartFallback,
  resolveExtendedSession,
  toEpochMs,
  type ExtendedSessionInput,
} from '../src/lib/extendedSession';
import { TickerQuote } from '../src/lib/types';

// Friday 2026-11-06 22:00 CET: the after-hours tick that used to survive the
// whole weekend on screen.
const FRIDAY_POST = Date.UTC(2026, 10, 6, 21, 0);
// Monday 2026-11-09 10:05 CET: pre-market opened 04:00 ET, so a live tick.
const MONDAY_PRE = Date.UTC(2026, 10, 9, 9, 5);
// Monday 2026-11-09 23:00 CET: after-hours tick of the same session.
const MONDAY_POST = Date.UTC(2026, 10, 9, 22, 0);

const base = (overrides: Partial<ExtendedSessionInput> = {}): ExtendedSessionInput => ({
  marketState: null,
  preMarketPrice: null,
  preMarketChangePercent: null,
  preMarketTime: null,
  postMarketPrice: null,
  postMarketChangePercent: null,
  postMarketTime: null,
  referencePrice: 100,
  ...overrides,
});

describe('Extended session resolution', () => {
  test('reports a live pre-market session with the tick timestamp', () => {
    const session = resolveExtendedSession(
      base({
        marketState: 'PRE',
        preMarketPrice: 101.5,
        preMarketChangePercent: 1.5,
        preMarketTime: MONDAY_PRE,
      })
    );

    assert.equal(session.type, 'pre');
    assert.equal(session.live, true);
    assert.equal(session.price, 101.5);
    assert.equal(session.changePercent, 1.5);
    assert.equal(session.asOf, MONDAY_PRE);
    assert.equal(session.source, 'computed');
  });

  test('reports a live after-hours session', () => {
    const session = resolveExtendedSession(
      base({ marketState: 'POST', postMarketPrice: 98.75, postMarketTime: FRIDAY_POST })
    );

    assert.equal(session.type, 'post');
    assert.equal(session.live, true);
    assert.equal(session.changePercent, -1.25);
  });

  test('computes the percentage itself when Yahoo omits it', () => {
    const session = resolveExtendedSession(
      base({ marketState: 'PRE', preMarketPrice: 102, preMarketTime: MONDAY_PRE })
    );

    assert.equal(session.changePercent, 2);
    assert.equal(session.source, 'computed');
  });

  test("falls back to Yahoo's percentage when the reference price is unknown", () => {
    const session = resolveExtendedSession(
      base({
        marketState: 'PRE',
        preMarketPrice: 102,
        preMarketChangePercent: 1.94,
        referencePrice: null,
      })
    );

    assert.equal(session.changePercent, 1.94);
    assert.equal(session.source, 'quote');
  });

  test('never borrows the other session while one is open', () => {
    // A morning pre-market tick still sitting on the quote must not be shown as
    // live after the close: only the POST fields may feed a POST session.
    const session = resolveExtendedSession(
      base({
        marketState: 'POST',
        preMarketPrice: 104,
        preMarketChangePercent: 4,
        preMarketTime: MONDAY_PRE,
        postMarketPrice: 99,
        postMarketTime: FRIDAY_POST,
      })
    );

    assert.equal(session.type, 'post');
    assert.equal(session.price, 99);
    assert.equal(session.changePercent, -1);
  });

  test('flags a closed session as historical instead of live', () => {
    const session = resolveExtendedSession(
      base({
        marketState: 'PREPRE',
        postMarketPrice: 101.1,
        postMarketChangePercent: 1.1,
        postMarketTime: FRIDAY_POST,
      })
    );

    assert.equal(session.type, 'post');
    assert.equal(session.live, false);
    assert.equal(session.asOf, FRIDAY_POST);
    assert.equal(session.changePercent, 1.1);
  });

  test('POSTPOST shows the after-hours session, not the morning pre-market one', () => {
    // Regression: the old rule preferred pre-market fields whenever the state
    // was not exactly POST, so the badge jumped back to the morning's figure.
    const session = resolveExtendedSession(
      base({
        marketState: 'POSTPOST',
        preMarketPrice: 104,
        preMarketChangePercent: 4,
        preMarketTime: MONDAY_PRE,
        postMarketPrice: 99,
        postMarketChangePercent: -1,
        postMarketTime: MONDAY_POST,
      })
    );

    assert.equal(session.type, 'post');
    assert.equal(session.changePercent, -1);
    assert.equal(session.live, false);
    assert.equal(session.asOf, MONDAY_POST);
  });

  test('prefers the after-hours side when neither side is timestamped', () => {
    const session = resolveExtendedSession(
      base({
        marketState: 'CLOSED',
        preMarketPrice: 104,
        preMarketChangePercent: 4,
        postMarketPrice: 99,
        postMarketChangePercent: -1,
      })
    );

    assert.equal(session.type, 'post');
    assert.equal(session.changePercent, -1);
  });

  test('a dated side beats an undated one', () => {
    const session = resolveExtendedSession(
      base({
        marketState: 'CLOSED',
        preMarketPrice: 104,
        preMarketChangePercent: 4,
        postMarketPrice: 99,
        postMarketTime: FRIDAY_POST,
      })
    );

    assert.equal(session.type, 'post');
    assert.equal(session.asOf, FRIDAY_POST);
  });

  test('returns nothing when Yahoo has no extended fields (regular session)', () => {
    assert.deepEqual(resolveExtendedSession(base({ marketState: 'REGULAR' })), NO_EXTENDED_SESSION);
    assert.deepEqual(resolveExtendedSession(base({ marketState: 'CLOSED' })), NO_EXTENDED_SESSION);
  });

  test('marks a live session whose fields are empty so the chart fallback can run', () => {
    const session = resolveExtendedSession(base({ marketState: 'PRE' }));

    assert.equal(session.type, 'pre');
    assert.equal(session.live, true);
    assert.equal(session.price, null);
    assert.equal(session.changePercent, null);
    assert.equal(session.source, null);
  });

  test('uses the chart bar when the quote cannot describe the open session', () => {
    const session = resolveExtendedSession(
      base({ marketState: 'PRE', chart: { type: 'pre', price: 103, asOf: MONDAY_PRE } })
    );

    assert.equal(session.type, 'pre');
    assert.equal(session.price, 103);
    assert.equal(session.changePercent, 3);
    assert.equal(session.asOf, MONDAY_PRE);
    assert.equal(session.source, 'chart');
  });

  test('ignores a chart bar that belongs to the other session', () => {
    const session = resolveExtendedSession(
      base({ marketState: 'PRE', chart: { type: 'post', price: 103, asOf: FRIDAY_POST } })
    );

    assert.equal(session.price, null);
    assert.equal(session.source, null);
  });

  test('keeps the quote price when the chart bar is older than what Yahoo gave', () => {
    const session = resolveExtendedSession(
      base({
        marketState: 'POST',
        postMarketPrice: 99,
        postMarketTime: FRIDAY_POST,
        chart: { type: 'post', price: 98, asOf: FRIDAY_POST - 60_000 },
      })
    );

    assert.equal(session.price, 99);
    assert.equal(session.changePercent, -1);
  });
});

describe('Extended session helpers', () => {
  const quote = (overrides: Partial<TickerQuote> = {}): TickerQuote => ({
    symbol: 'NVDA',
    name: 'NVIDIA Corporation',
    price: 100,
    change: 0,
    changePercent: 0,
    currency: 'USD',
    trailingPE: null,
    forwardPE: null,
    marketCap: null,
    dividendYield: null,
    fiftyTwoWeekHigh: null,
    fiftyTwoWeekLow: null,
    epsTrailingTwelveMonths: null,
    beta: null,
    volume: null,
    avgVolume: null,
    exchange: 'NMS',
    quoteType: 'EQUITY',
    updatedAt: Date.now(),
    ...overrides,
  });

  test('applyExtendedSession copies the resolved session onto the quote', () => {
    const target = quote();
    applyExtendedSession(target, {
      type: 'post',
      price: 101.1,
      changePercent: 1.1,
      asOf: FRIDAY_POST,
      live: false,
      source: 'computed',
    });

    assert.equal(target.extendedType, 'post');
    assert.equal(target.extendedPrice, 101.1);
    assert.equal(target.extendedChangePercent, 1.1);
    assert.equal(target.extendedAsOf, FRIDAY_POST);
    assert.equal(target.extendedLive, false);
    assert.equal(target.extendedSource, 'computed');
  });

  test('asks for the chart fallback only for a live session missing a figure', () => {
    assert.equal(extendedSessionNeedsChartFallback(quote({ extendedLive: true, extendedType: 'pre', extendedPrice: null })), true);
    assert.equal(
      extendedSessionNeedsChartFallback(
        quote({ extendedLive: true, extendedType: 'pre', extendedPrice: 101, extendedChangePercent: 1 })
      ),
      false
    );
    // A historical session is complete by definition: no extra request.
    assert.equal(
      extendedSessionNeedsChartFallback(
        quote({ extendedLive: false, extendedType: 'post', extendedPrice: 99, extendedChangePercent: -1 })
      ),
      false
    );
    assert.equal(extendedSessionNeedsChartFallback(quote()), false);
  });

  test('toEpochMs accepts dates, epoch milliseconds, ISO strings and nothing', () => {
    assert.equal(toEpochMs(new Date(FRIDAY_POST)), FRIDAY_POST);
    assert.equal(toEpochMs(FRIDAY_POST), FRIDAY_POST);
    assert.equal(toEpochMs(new Date(FRIDAY_POST).toISOString()), FRIDAY_POST);
    assert.equal(toEpochMs(null), null);
    assert.equal(toEpochMs(undefined), null);
    assert.equal(toEpochMs('not a date'), null);
  });
});
