// Background price-alert scan.
//
// Runs from a Cloudflare cron trigger every five minutes. The handler itself
// decides which tickers are worth asking Yahoo about, so the trigger can stay a
// simple 24/7 `*/5 * * * *` while closed venues cost zero upstream calls.
//
// Cost model (the reason this module exists rather than reusing getBatchQuotes):
//   - one batched Yahoo request per 50 distinct open symbols;
//   - zero KV writes on a scan where nothing triggers;
//   - one state write per user whose arming state changed;
//   - one `quote:<SYM>` write per symbol that triggered (24h TTL), so the
//     dashboard shows the trigger price when the user opens the notification.

import { kvGet, kvPut } from './kv';
import { getAlertStateMap, putAlertStateMap } from './alertStore';
import { alertsEnabled, evaluateAlerts } from './alerts';
import { UserAlertEvent } from './alertNotification';
import { UserTicker } from './types';
import { buildMarketSessions } from './marketCalendar';
import { getExchangeRates } from './exchangeRates';
import { getQuotesBatched } from './yahooFinance';
import { getWatchlistRepository } from './tickerStore';

/**
 * How long a trigger price stays in the shared quote cache.
 *
 * The interactive cache only treats an entry as fresh for 30 seconds, so this
 * is not about freshness: it is about keeping a usable fallback (tier 4 of the
 * quote path) for a user who opens the app hours after the notification.
 */
const TRIGGERED_QUOTE_TTL_SEC = 24 * 60 * 60;

/**
 * Non-atomic "one scan at a time" marker.
 *
 * Written only when the plan is non-empty, and left to expire instead of being
 * deleted: outside market hours a scan costs zero KV writes, and during market
 * hours it costs one. The TTL is shorter than the trigger interval (five
 * minutes) so the next run always proceeds.
 *
 * The lock is not a correctness guarantee: Workers KV has no compare-and-set, so
 * two invocations starting in the same instant can both observe it empty. A
 * duplicate scan is harmless because the first one has already disarmed the side
 * it fired.
 */
const LOCK_KEY = 'cron:alerts:lock';
const LOCK_TTL_SEC = 4 * 60;


export interface AlertScanEntry {
  userId: string;
  tickers: UserTicker[];
}

export interface AlertScanCandidate {
  userId: string;
  ticker: UserTicker;
}

export interface AlertScanPlan {
  candidates: AlertScanCandidate[];
  /** Distinct symbols to request, uppercased. */
  symbols: string[];
}

export interface AlertScanResult {
  /** True when another scan held the lock. */
  skipped: boolean;
  /** Tickers that were eligible (alerts enabled and venue open). */
  scannedTickers: number;
  /** Quotes actually returned by Yahoo for this scan. */
  fetchedQuotes: number;
  triggered: UserAlertEvent[];
  /** Number of per-user state keys written. */
  stateWrites: number;
  /** Number of quote-cache keys written. */
  quoteWrites: number;
}

/**
 * Whether a venue is inside a regular session at `now`.
 *
 * An unknown timezone or a venue missing from the calendar is treated as open:
 * silently skipping a market we know nothing about would disable alerts for
 * every exotic listing, which is worse than spending one batched request.
 */
export function isVenueOpen(timezone: string | null | undefined, now: number): boolean {
  if (!timezone) return true;

  const sessions = buildMarketSessions(timezone, now, 1);
  if (!sessions || sessions.length === 0) return true;

  return sessions.some((session) => session.opensAt <= now && now < session.closesAt);
}

function tickerTimezone(ticker: UserTicker): string | null | undefined {
  return ticker.exchangeTimezone ?? ticker.quote?.exchangeTimezone ?? null;
}

/**
 * Select the tickers to evaluate and the symbols to request.
 *
 * Pure so the scheduling rules (opt-in, open venue, symbol de-duplication) can
 * be tested without KV or network.
 */
export function planScan(entries: AlertScanEntry[], now: number): AlertScanPlan {
  const candidates: AlertScanCandidate[] = [];
  const symbols = new Set<string>();

  for (const { userId, tickers } of entries) {
    for (const ticker of tickers) {
      if (!alertsEnabled(ticker)) continue;

      // Futures trade nearly around the clock and carry no regular session in
      // their quote, so the exchange calendar must not gate them.
      const alwaysOpen = ticker.quote?.quoteType === 'FUTURE';
      if (!alwaysOpen && !isVenueOpen(tickerTimezone(ticker), now)) continue;

      candidates.push({ userId, ticker });
      symbols.add(ticker.symbol.toUpperCase());
    }
  }

  return { candidates, symbols: Array.from(symbols) };
}

/**
 * Read every watchlist, evaluate the open tickers, persist the arming changes
 * and cache the quotes that triggered.
 *
 * The state is written *before* returning, so a caller that sends notifications
 * afterwards cannot double-send if the process dies between the two steps.
 */
export async function runAlertScan(now: number = Date.now()): Promise<AlertScanResult> {
  const entries = await getWatchlistRepository().listAllForScan();

  const plan = planScan(entries, now);
  if (plan.symbols.length === 0) {
    // Nothing open and nothing armed: return before touching the lock, so a
    // night or a weekend costs zero KV writes.
    return {
      skipped: false,
      scannedTickers: 0,
      fetchedQuotes: 0,
      triggered: [],
      stateWrites: 0,
      quoteWrites: 0,
    };
  }

  if (await kvGet(LOCK_KEY)) {
    return {
      skipped: true,
      scannedTickers: 0,
      fetchedQuotes: 0,
      triggered: [],
      stateWrites: 0,
      quoteWrites: 0,
    };
  }

  // One write per active scan; expiry is shorter than the cron interval.
  await kvPut(LOCK_KEY, String(now), { expirationTtl: LOCK_TTL_SEC });

  const quotes = await getQuotesBatched(plan.symbols);

  let rates: Record<string, number> | null = null;
  try {
    // Cached for 24h in KV, so this is at most one read per scan and one write
    // per day. A failure degrades to no FX conversion instead of skipping the
    // scan entirely.
    rates = (await getExchangeRates()).rates;
  } catch (err) {
    console.warn('Alert scan: exchange rates unavailable, FX thresholds skipped:', err);
  }

  // Group by user so one user's state is read and written exactly once.
  const byUser = new Map<string, AlertScanCandidate[]>();
  for (const candidate of plan.candidates) {
    const list = byUser.get(candidate.userId);
    if (list) list.push(candidate);
    else byUser.set(candidate.userId, [candidate]);
  }

  const triggered: UserAlertEvent[] = [];
  let stateWrites = 0;

  for (const [userId, candidates] of byUser) {
    const stateMap = await getAlertStateMap(userId);
    let dirty = false;

    for (const { ticker } of candidates) {
      const quote = quotes[ticker.symbol.toUpperCase()];
      if (!quote) continue;

      const result = evaluateAlerts(ticker, quote, rates, stateMap[ticker.id], now);
      if (result.events.length > 0) {
        for (const event of result.events) triggered.push({ ...event, userId });
      }

      if (result.changed) {
        stateMap[ticker.id] = result.state;
        dirty = true;
      }
    }

    if (dirty) {
      await putAlertStateMap(userId, stateMap);
      stateWrites++;
    }
  }

  // One cache write per triggered symbol, shared by every user watching it.
  const triggeredSymbols = new Set(triggered.map((event) => event.symbol));
  let quoteWrites = 0;
  for (const symbol of triggeredSymbols) {
    const quote = quotes[symbol];
    if (!quote) continue;
    await kvPut(`quote:${symbol}`, quote, { expirationTtl: TRIGGERED_QUOTE_TTL_SEC });
    quoteWrites++;
  }

  return {
    skipped: false,
    scannedTickers: plan.candidates.length,
    fetchedQuotes: Object.keys(quotes).length,
    triggered,
    stateWrites,
    quoteWrites,
  };
}
