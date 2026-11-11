// Extended-session (pre-market / after-hours) resolution.
//
// Yahoo's v7 quote keeps the preMarket*/postMarket* fields after the session
// they describe has closed: on a Sunday morning the quote still carries Friday's
// after-hours tick, and during the pre-market-open window it carries nothing but
// that Friday figure. Rendering those fields as "current" is what made the badge
// freeze for hours (or days) and show a percentage from another session.
//
// This module turns the raw fields into an explicit answer - which session, from
// when, and whether it is live right now - so the UI never has to guess. It is
// pure and dependency-free so the policy can be unit-tested without network.
import type { ExtendedSessionSource, ExtendedSessionType, TickerQuote } from './types';

export interface ExtendedSessionInput {
  /** Yahoo `marketState`: PRE / PREPRE / REGULAR / POST / POSTPOST / CLOSED. */
  marketState: string | null | undefined;
  preMarketPrice: number | null;
  preMarketChangePercent: number | null;
  preMarketTime: number | null;
  postMarketPrice: number | null;
  postMarketChangePercent: number | null;
  postMarketTime: number | null;
  /**
   * Price the extended tick is compared against. Yahoo uses the last regular
   * price, which is still the previous close while the venue is pre-market
   * (it is *not* `regularMarketPreviousClose`).
   */
  referencePrice: number | null;
  /**
   * Last pre/post bar of the intraday chart, used when the quote claims an open
   * session but carries no usable price for it.
   */
  chart?: { type: ExtendedSessionType; price: number; asOf: number } | null;
}

export interface ExtendedSession {
  type: ExtendedSessionType | null;
  price: number | null;
  changePercent: number | null;
  /** Epoch ms of the tick behind the figures, null when Yahoo did not say. */
  asOf: number | null;
  /** True only while the venue is inside that extended session right now. */
  live: boolean;
  source: ExtendedSessionSource | null;
}

export const NO_EXTENDED_SESSION: ExtendedSession = Object.freeze({
  type: null,
  price: null,
  changePercent: null,
  asOf: null,
  live: false,
  source: null,
});

function round(value: number | null, digits: number): number | null {
  return value === null || !Number.isFinite(value) ? null : Number(value.toFixed(digits));
}

function percentFromPrice(price: number | null, referencePrice: number | null): number | null {
  if (price === null || referencePrice === null || price <= 0 || referencePrice <= 0) return null;
  return round((price / referencePrice - 1) * 100, 2);
}

/** Yahoo's marketState values that mean "this extended session is open". */
function liveSessionType(marketState: string | null | undefined): ExtendedSessionType | null {
  if (marketState === 'PRE') return 'pre';
  if (marketState === 'POST') return 'post';
  return null;
}

/**
 * Coerce a Yahoo timestamp (Date, epoch ms or ISO string) to epoch ms.
 * yahoo-finance2 returns Dates from `quote()`, but cached JSON only holds
 * numbers, so both shapes have to be accepted.
 */
export function toEpochMs(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value as string | number).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function extendedSessionInputFromQuote(
  quote: TickerQuote,
  referencePrice: number | null = quote.price
): ExtendedSessionInput {
  return {
    marketState: quote.marketState ?? null,
    preMarketPrice: quote.preMarketPrice ?? null,
    preMarketChangePercent: quote.preMarketChangePercent ?? null,
    preMarketTime: quote.preMarketTime ?? null,
    postMarketPrice: quote.postMarketPrice ?? null,
    postMarketChangePercent: quote.postMarketChangePercent ?? null,
    postMarketTime: quote.postMarketTime ?? null,
    referencePrice,
  };
}

/**
 * Resolve which extended session to show.
 *
 * - Session open right now (`PRE` / `POST`): its own fields only. Never borrowing
 *   the other side is what stops the previous session from reappearing.
 * - No session open (`PREPRE`, `POSTPOST`, `CLOSED`, `REGULAR`): the fields still
 *   describe the last session, so it is returned for context but flagged
 *   `live: false` and dated, letting the UI grey it out and print its timestamp.
 * - No extended data at all: nothing is shown.
 */
export function resolveExtendedSession(input: ExtendedSessionInput): ExtendedSession {
  const live = liveSessionType(input.marketState);

  if (live) {
    const side =
      live === 'pre'
        ? { price: input.preMarketPrice, percent: input.preMarketChangePercent, asOf: input.preMarketTime }
        : { price: input.postMarketPrice, percent: input.postMarketChangePercent, asOf: input.postMarketTime };

    let price = side.price;
    let asOf = side.asOf;
    let percent = percentFromPrice(price, input.referencePrice);
    let source: ExtendedSessionSource | null = percent !== null ? 'computed' : null;

    // Yahoo's own percentage is the fallback when the reference price is missing.
    if (percent === null && side.percent !== null) {
      percent = round(side.percent, 2);
      source = 'quote';
    }

    // Degraded quote: the state says the session is open but its fields are empty.
    // The chart is the only endpoint that timestamps extended ticks, so it is the
    // fallback that still yields a live, datable figure.
    if ((price === null || percent === null) && input.chart?.type === live) {
      const chartPercent = percentFromPrice(input.chart.price, input.referencePrice);
      if (chartPercent !== null) {
        price = input.chart.price;
        asOf = input.chart.asOf;
        percent = chartPercent;
        source = 'chart';
      }
    }

    return { type: live, price: round(price, 4), changePercent: percent, asOf, live: true, source };
  }

  const sides = [
    // Post first so an untimestamped tie resolves to the session that ends last.
    { type: 'post' as const, price: input.postMarketPrice, percent: input.postMarketChangePercent, asOf: input.postMarketTime },
    { type: 'pre' as const, price: input.preMarketPrice, percent: input.preMarketChangePercent, asOf: input.preMarketTime },
  ].filter((side) => side.price !== null || side.percent !== null);

  if (sides.length === 0) return NO_EXTENDED_SESSION;

  // A known timestamp always beats an unknown one; the sort is stable, so equal
  // keys keep the post-first order. This is what fixes POSTPOST showing the
  // morning's pre-market percentage instead of the after-hours one.
  sides.sort((a, b) => (b.asOf ?? 0) - (a.asOf ?? 0));
  const latest = sides[0];

  const computed = percentFromPrice(latest.price, input.referencePrice);
  const percent = computed ?? round(latest.percent, 2);
  const source: ExtendedSessionSource | null = computed !== null ? 'computed' : percent !== null ? 'quote' : null;

  return {
    type: latest.type,
    price: round(latest.price, 4),
    changePercent: percent,
    asOf: latest.asOf,
    live: false,
    source,
  };
}

/** Copy a resolved session onto a quote payload. */
export function applyExtendedSession(quote: TickerQuote, session: ExtendedSession): void {
  quote.extendedType = session.type;
  quote.extendedPrice = session.price;
  quote.extendedChangePercent = session.changePercent;
  quote.extendedAsOf = session.asOf;
  quote.extendedLive = session.live;
  quote.extendedSource = session.source;
}

/** Whether an open session still lacks the price/percentage the UI needs. */
export function extendedSessionNeedsChartFallback(quote: TickerQuote): boolean {
  return (
    quote.extendedLive === true &&
    (quote.extendedType === 'pre' || quote.extendedType === 'post') &&
    (quote.extendedPrice === null || quote.extendedChangePercent === null)
  );
}
