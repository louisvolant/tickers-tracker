import YahooFinance from 'yahoo-finance2';
import { kvGet, kvPut } from './kv';
import { normalizeCurrency } from './currencies';
import { buildMarketSessions } from './marketCalendar';
import {
  applyExtendedSession,
  extendedSessionInputFromQuote,
  extendedSessionNeedsChartFallback,
  resolveExtendedSession,
  toEpochMs,
} from './extendedSession';
import { TickerQuote, TickerSearchResult, ChartPoint, TickerDetails, ForwardConsensusData, EarningsEstimatePeriod } from './types';

/**
 * The library only default-exports the client class, not a named instance
 * type, so the instance type is derived from the constructor.
 */
type YahooFinanceClient = InstanceType<typeof YahooFinance>;

/**
 * Create a Yahoo Finance client bound to a single request.
 *
 * yahoo-finance2 memoises the Yahoo crumb promise inside the per-client cookie
 * jar (see its `lib/getCrumb`: `crumbStates` is a WeakMap keyed by the jar, and
 * `state.promise` is reused by every caller sharing that jar).
 *
 * With a module-scope client - the natural thing to do on Node - every
 * concurrent request in a Workers isolate shares that one promise. The request
 * that created it resolves fine; the others await a promise belonging to a
 * request context that has already been torn down. The runtime cancels their
 * continuations, the handler never produces a response, and Cloudflare kills
 * the request:
 *
 *   "The Workers runtime canceled this request because it detected that your
 *    Worker's code had hung and would never generate a response."
 *   (HTTP 500, outcome: "exception")
 *
 * Creating one client per request keeps the crumb cache request-scoped, so
 * concurrent requests can never await each other's promises. The library's
 * per-instance fetch queue (`queues` WeakMap, also keyed by instance) is
 * isolated the same way.
 *
 * A client therefore has to be threaded through a request rather than created
 * per call: a batch of 30 symbols must share one crumb fetch, not perform 30.
 *
 * Exported so other server-side modules (the ATH/ATL snapshot) reuse this single
 * factory instead of instantiating a client of their own.
 */
export function createYahooFinanceClient(): YahooFinanceClient {
  return new YahooFinance({
    suppressNotices: ['yahooSurvey'],
  });
}

const QUOTE_CACHE_TTL_SEC = 30; // Cache quotes for 30 seconds in KV
const SEARCH_CACHE_TTL_SEC = 3600; // Cache search queries for 1 hour in KV
const CHART_CACHE_TTL_SEC = 600; // Cache chart data for 10 minutes in KV

/**
 * Normalizes Yahoo quote raw object into our standardized TickerQuote.
 */
function normalizeQuote(raw: any, symbolOverride?: string): TickerQuote {
  const sym = (raw.symbol || symbolOverride || '').toUpperCase();

  // Normalize Yahoo minor units (pence "GBp", cents "ZAc", "ILA") into their
  // major ISO currency so prices, EPS and reference-value conversions line up.
  const { code: currency, factor } = normalizeCurrency(raw.currency || 'USD');

  // Futures trade almost around the clock, so no session badge is computed for them.
  const quoteTypeValue = raw.quoteType || 'EQUITY';
  const exchangeTimezone: string | null = raw.exchangeTimezoneName || null;
  const marketSessions =
    quoteTypeValue === 'FUTURE' ? null : buildMarketSessions(exchangeTimezone, Date.now());

  const price = (raw.regularMarketPrice ?? 0) / factor;
  const epsForwardRaw = raw.epsForward !== undefined && raw.epsForward !== null ? Number(raw.epsForward) / factor : null;
  const epsTrailingRaw =
    raw.epsTrailingTwelveMonths !== undefined && raw.epsTrailingTwelveMonths !== null
      ? Number(raw.epsTrailingTwelveMonths) / factor
      : null;

  // Safe calculation for Trailing PE if missing
  let trailingPE = raw.trailingPE ?? null;
  if (!trailingPE && epsTrailingRaw && epsTrailingRaw > 0 && price > 0) {
    trailingPE = Number((price / epsTrailingRaw).toFixed(2));
  }

  // Safe calculation for Forward PE if missing
  let forwardPE = raw.forwardPE ?? null;
  if (!forwardPE && epsForwardRaw && epsForwardRaw > 0 && price > 0) {
    forwardPE = Number((price / epsForwardRaw).toFixed(2));
  }

  // Extended session (Pre-market / After-hours / Futures)
  //
  // The raw pre/post fields are kept as Yahoo reports them, but which one is
  // *current* is decided by resolveExtendedSession(): Yahoo still serves the
  // last session's fields after it closed (Friday's after-hours tick survives
  // the weekend), so their presence says nothing about their freshness.
  const toPrice = (value: unknown): number | null => {
    const n = value === null || value === undefined ? null : Number(value);
    return n === null || !Number.isFinite(n) ? null : Number((n / factor).toFixed(4));
  };
  const toPercent = (value: unknown): number | null => {
    const n = value === null || value === undefined ? null : Number(value);
    return n === null || !Number.isFinite(n) ? null : Number(n.toFixed(2));
  };

  const marketState = raw.marketState || null;

  const fiftyTwoWeekHigh = raw.fiftyTwoWeekHigh !== undefined && raw.fiftyTwoWeekHigh !== null ? Number(raw.fiftyTwoWeekHigh) / factor : null;
  const fiftyTwoWeekLow = raw.fiftyTwoWeekLow !== undefined && raw.fiftyTwoWeekLow !== null ? Number(raw.fiftyTwoWeekLow) / factor : null;

  // Intraday extremes of the current regular session. Alert rules read them so a
  // spike between two polls is still detected, even if the price already reverted.
  const dayHigh = raw.regularMarketDayHigh !== undefined && raw.regularMarketDayHigh !== null ? Number(raw.regularMarketDayHigh) / factor : null;
  const dayLow = raw.regularMarketDayLow !== undefined && raw.regularMarketDayLow !== null ? Number(raw.regularMarketDayLow) / factor : null;

  const quote: TickerQuote = {
    symbol: sym,
    name: raw.shortName || raw.longName || sym || 'Unknown',
    price: Number(price.toFixed(4)),
    change: Number(((raw.regularMarketChange ?? 0) / factor).toFixed(4)),
    changePercent: Number((raw.regularMarketChangePercent ?? 0).toFixed(2)),
    currency,
    trailingPE: trailingPE ? Number(trailingPE.toFixed(2)) : null,
    forwardPE: forwardPE ? Number(forwardPE.toFixed(2)) : null,
    marketCap: raw.marketCap ?? null,
    dividendYield: raw.dividendYield ? Number((raw.dividendYield * 100).toFixed(2)) : null,
    fiftyTwoWeekHigh,
    fiftyTwoWeekLow,
    dayHigh: dayHigh !== null ? Number(dayHigh.toFixed(4)) : null,
    dayLow: dayLow !== null ? Number(dayLow.toFixed(4)) : null,
    epsTrailingTwelveMonths: epsTrailingRaw,
    beta: raw.beta ?? null,
    volume: raw.regularMarketVolume ?? null,
    avgVolume: raw.averageDailyVolume3Month ?? null,
    exchange: raw.exchange || raw.fullExchangeName || '',
    quoteType: quoteTypeValue,
    exchangeTimezone,
    marketSessions,
    updatedAt: Date.now(),
    marketState,
    preMarketPrice: toPrice(raw.preMarketPrice),
    preMarketChange: toPrice(raw.preMarketChange),
    preMarketChangePercent: toPercent(raw.preMarketChangePercent),
    preMarketTime: toEpochMs(raw.preMarketTime),
    postMarketPrice: toPrice(raw.postMarketPrice),
    postMarketChange: toPrice(raw.postMarketChange),
    postMarketChangePercent: toPercent(raw.postMarketChangePercent),
    postMarketTime: toEpochMs(raw.postMarketTime),
  };

  // The extended figures are computed from the price and timestamp Yahoo reports,
  // not taken on faith from its percentage, and are flagged live or historical.
  applyExtendedSession(quote, resolveExtendedSession(extendedSessionInputFromQuote(quote)));

  return quote;
}

/**
 * Fallback to direct public Chart API if Yahoo Finance crumb/cookie is throttled
 */
async function fetchChartDirect(symbol: string): Promise<any | null> {
  try {
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)',
        'Accept': 'application/json',
      },
    });
    if (!res.ok) return null;
    const json = await res.json();
    const result = json.chart?.result?.[0];
    if (!result || !result.meta) return null;

    const meta = result.meta;
    const currentPrice = meta.regularMarketPrice ?? meta.previousClose ?? 0;
    const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? currentPrice;
    const change = currentPrice - prevClose;
    const changePercent = prevClose ? (change / prevClose) * 100 : 0;

    return {
      symbol: meta.symbol || symbol,
      shortName: meta.shortName || meta.symbol || symbol,
      regularMarketPrice: currentPrice,
      regularMarketChange: change,
      regularMarketChangePercent: changePercent,
      currency: meta.currency || 'USD',
      exchange: meta.exchangeName || '',
      exchangeTimezoneName: meta.exchangeTimezoneName,
      quoteType: meta.instrumentType,
      fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
      fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
      regularMarketVolume: meta.regularMarketVolume,
    };
  } catch (err) {
    console.debug(`Chart direct fallback failed for ${symbol}:`, err);
    return null;
  }
}

/**
 * Last pre/post bar of the intraday chart.
 *
 * Used when the quote advertises an open extended session but carries no usable
 * price for it (illiquid symbols). `includePrePost` is what makes the chart
 * return the extended ticks, and the bar date is the only trustworthy "as of"
 * available in that case.
 */
async function fetchExtendedBar(
  yf: YahooFinanceClient,
  symbol: string,
  type: 'pre' | 'post'
): Promise<{ type: 'pre' | 'post'; price: number; asOf: number } | null> {
  try {
    const chart = await yf.chart(symbol, {
      period1: new Date(Date.now() - 2 * 86_400_000),
      interval: '1m',
      includePrePost: true,
      return: 'array',
    });

    const period = chart?.meta?.currentTradingPeriod?.[type];
    if (!period) return null;

    const start = toEpochMs(period.start);
    const end = toEpochMs(period.end);
    if (start === null || end === null) return null;

    let last: { price: number; asOf: number } | null = null;
    for (const bar of chart.quotes ?? []) {
      const asOf = toEpochMs(bar?.date);
      if (asOf === null || asOf < start || asOf > end) continue;
      const close = bar?.close === null || bar?.close === undefined ? null : Number(bar.close);
      if (close === null || !Number.isFinite(close)) continue;
      last = { price: close, asOf };
    }

    return last ? { type, ...last } : null;
  } catch (err) {
    console.debug(`Extended-hours chart fallback failed for ${symbol}:`, err);
    return null;
  }
}

/**
 * Fill in a live extended session the quote could not describe, using at most one
 * extra chart request and only in the degraded case (state says the session is
 * open, the fields are empty). The quote API is the primary source: one chart call
 * per symbol per refresh would double the upstream request count and is the
 * fastest way to get rate-limited.
 */
async function applyChartExtendedFallback(yf: YahooFinanceClient, quote: TickerQuote): Promise<void> {
  if (!extendedSessionNeedsChartFallback(quote)) return;

  const bar = await fetchExtendedBar(yf, quote.symbol, quote.extendedType as 'pre' | 'post');
  if (!bar) return;

  applyExtendedSession(
    quote,
    resolveExtendedSession({ ...extendedSessionInputFromQuote(quote), chart: bar })
  );
}

/**
 * Fetch a single ticker quote with multi-tiered resilience and KV caching,
 * reusing the caller's request-scoped client.
 */
async function fetchQuoteWithClient(
  yf: YahooFinanceClient,
  symbol: string
): Promise<TickerQuote | null> {
  const cleanSymbol = symbol.trim().toUpperCase();
  if (!cleanSymbol) return null;

  const cacheKey = `quote:${cleanSymbol}`;
  const cached = await kvGet<TickerQuote>(cacheKey);
  if (cached && Date.now() - cached.updatedAt < QUOTE_CACHE_TTL_SEC * 1000) {
    return cached;
  }

  // Tier 1: Try yf.quote
  try {
    const raw = await yf.quote(cleanSymbol);
    if (raw && raw.symbol) {
      const quote = normalizeQuote(raw, cleanSymbol);
      await applyChartExtendedFallback(yf, quote);
      await kvPut(cacheKey, quote, { expirationTtl: QUOTE_CACHE_TTL_SEC * 4 });
      return quote;
    }
  } catch (err: any) {
    console.warn(`yf.quote tier 1 warning for ${cleanSymbol}:`, err?.message || err);
  }

  // Tier 2: Try yf.quoteSummary
  try {
    const qs = await yf.quoteSummary(cleanSymbol, {
      modules: ['price', 'summaryDetail', 'defaultKeyStatistics'],
    });
    if (qs && qs.price && qs.price.regularMarketPrice !== undefined) {
      const merged = {
        symbol: cleanSymbol,
        shortName: qs.price.shortName || cleanSymbol,
        longName: qs.price.longName,
        regularMarketPrice: qs.price.regularMarketPrice,
        regularMarketChange: qs.price.regularMarketChange,
        regularMarketChangePercent: qs.price.regularMarketChangePercent,
        currency: qs.price.currency,
        exchange: qs.price.exchangeName,
        quoteType: qs.price.quoteType,
        marketCap: qs.price.marketCap || qs.summaryDetail?.marketCap,
        trailingPE: qs.summaryDetail?.trailingPE,
        forwardPE: qs.summaryDetail?.forwardPE || qs.defaultKeyStatistics?.forwardPE,
        dividendYield: qs.summaryDetail?.dividendYield,
        fiftyTwoWeekHigh: qs.summaryDetail?.fiftyTwoWeekHigh,
        fiftyTwoWeekLow: qs.summaryDetail?.fiftyTwoWeekLow,
        epsTrailingTwelveMonths: qs.defaultKeyStatistics?.trailingEps,
        beta: qs.defaultKeyStatistics?.beta,
        regularMarketVolume: qs.price.regularMarketVolume,
        averageDailyVolume3Month: qs.price.averageDailyVolume3Month,
      };
      const quote = normalizeQuote(merged, cleanSymbol);
      await kvPut(cacheKey, quote, { expirationTtl: QUOTE_CACHE_TTL_SEC * 4 });
      return quote;
    }
  } catch (err: any) {
    console.warn(`yf.quoteSummary tier 2 warning for ${cleanSymbol}:`, err?.message || err);
  }

  // Tier 3: Direct chart fallback
  const directData = await fetchChartDirect(cleanSymbol);
  if (directData) {
    const quote = normalizeQuote(directData, cleanSymbol);
    // Keep cached PE if we previously had it
    if (cached) {
      quote.trailingPE = cached.trailingPE;
      quote.forwardPE = cached.forwardPE;
      quote.marketCap = cached.marketCap;
      quote.dividendYield = cached.dividendYield;
    }
    await kvPut(cacheKey, quote, { expirationTtl: QUOTE_CACHE_TTL_SEC * 4 });
    return quote;
  }

  // Tier 4: Return stale cache if available
  if (cached) {
    return cached;
  }

  return null;
}

/**
 * Fetch a single ticker quote. Opens its own request-scoped client.
 */
export async function getQuote(symbol: string): Promise<TickerQuote | null> {
  return fetchQuoteWithClient(createYahooFinanceClient(), symbol);
}

/**
 * Batch fetch multiple ticker quotes.
 */
export async function getBatchQuotes(symbols: string[]): Promise<Record<string, TickerQuote>> {
  const uniqueSymbols = Array.from(new Set(symbols.map((s) => s.trim().toUpperCase()))).filter(Boolean);
  if (uniqueSymbols.length === 0) return {};

  const results: Record<string, TickerQuote> = {};
  const toFetch: string[] = [];

  // Check KV cache first
  for (const sym of uniqueSymbols) {
    const cached = await kvGet<TickerQuote>(`quote:${sym}`);
    if (cached && Date.now() - cached.updatedAt < QUOTE_CACHE_TTL_SEC * 1000) {
      results[sym] = cached;
    } else {
      toFetch.push(sym);
      if (cached) {
        results[sym] = cached;
      }
    }
  }

  if (toFetch.length === 0) {
    return results;
  }

  // One client for the whole batch: every symbol in a request shares a single
  // crumb fetch instead of triggering one per symbol.
  const yf = createYahooFinanceClient();

  // Fetch missing concurrently
  const fetchPromises = toFetch.map(async (sym) => {
    try {
      const quote = await fetchQuoteWithClient(yf, sym);
      if (quote) {
        results[sym] = quote;
      }
    } catch (err) {
      console.error(`Batch fetch error for ${sym}:`, err);
    }
  });

  await Promise.allSettled(fetchPromises);
  return results;
}

/**
 * Maximum number of symbols per Yahoo quote request.
 *
 * Yahoo's v7 quote endpoint accepts many symbols in one call (the library's own
 * `quoteCombine` defaults to 100). 50 keeps the query string comfortably short
 * and bounds the blast radius of a malformed row.
 */
const QUOTE_BATCH_SIZE = 50;

/**
 * Fetch many quotes with one HTTP request per batch, **without touching KV**.
 *
 * `getBatchQuotes()` above is built for the interactive path: it keeps one KV
 * entry per symbol so a partial watchlist can be served fast, with a per-symbol
 * stale fallback. A background consumer (the price-alert scanner) has the
 * opposite needs: it reads the prices once, keeps them in memory, and must not
 * spend hundreds of KV writes per run. This entry point therefore batches at
 * the HTTP level and performs no cache read or write.
 */
export async function getQuotesBatched(symbols: string[]): Promise<Record<string, TickerQuote>> {
  const unique = Array.from(new Set(symbols.map((s) => s.trim().toUpperCase()))).filter(Boolean);
  if (unique.length === 0) return {};

  // One client for the whole scan, so every batch shares a single crumb fetch.
  const yf = createYahooFinanceClient();
  const results: Record<string, TickerQuote> = {};

  for (let i = 0; i < unique.length; i += QUOTE_BATCH_SIZE) {
    const chunk = unique.slice(i, i + QUOTE_BATCH_SIZE);

    try {
      // validateResult: false keeps a single malformed row from rejecting the
      // whole batch; normalizeQuote() already defends against missing fields.
      const rows = (await yf.quote(
        chunk,
        { return: 'array' },
        { validateResult: false }
      )) as any[];

      for (const row of rows || []) {
        if (!row?.symbol) continue;
        const symbol = String(row.symbol).toUpperCase();
        if (!chunk.includes(symbol)) continue;
        results[symbol] = normalizeQuote(row, symbol);
      }
    } catch (err) {
      console.warn(`Batched quote request failed for ${chunk.length} symbols:`, err);
    }

    // Retry only the symbols the batch did not return, one by one: an unknown or
    // delisted symbol must not cost the whole chunk.
    const missing = chunk.filter((symbol) => !results[symbol]);
    if (missing.length === 0) continue;

    await Promise.allSettled(
      missing.map(async (symbol) => {
        try {
          const row = await yf.quote(symbol, {}, { validateResult: false });
          if (row?.symbol) results[symbol] = normalizeQuote(row, symbol);
        } catch {
          // Unknown, delisted or throttled symbol: skip it for this scan.
        }
      })
    );
  }

  return results;
}

import { searchCatalog } from './stockCatalog';

/**
 * Autocomplete / Search tickers via Curated Catalog & Yahoo Finance.
 * Supports search by ticker symbol, company label / name, or ISIN code.
 */
export async function searchTickers(query: string): Promise<TickerSearchResult[]> {
  const cleanQuery = query.trim().toLowerCase();
  if (!cleanQuery || cleanQuery.length < 1) return [];

  const cacheKey = `search:${cleanQuery}`;
  const cached = await kvGet<TickerSearchResult[]>(cacheKey);
  if (cached) return cached;

  // 1. Check curated catalog for ticker, label, or ISIN match
  const catalogMatches = searchCatalog(query);
  const seenSymbols = new Set(catalogMatches.map((m) => m.symbol.toUpperCase()));

  try {
    const yf = createYahooFinanceClient();
    const res = await yf.search(cleanQuery, {
      newsCount: 0,
      quotesCount: 8,
    });

    const yahooItems = (res.quotes || [])
      .filter((q: any) => q.isYahooFinance && q.symbol)
      .map((q: any) => ({
        symbol: q.symbol,
        name: q.shortname || q.longname || q.symbol,
        exchange: q.exchDisp || q.exchange || '',
        quoteType: q.quoteType || q.typeDisp || 'EQUITY',
        sector: q.sector || '',
        industry: q.industry || '',
      }))
      .filter((item: TickerSearchResult) => !seenSymbols.has(item.symbol.toUpperCase()));

    const combined = [...catalogMatches, ...yahooItems];
    await kvPut(cacheKey, combined, { expirationTtl: SEARCH_CACHE_TTL_SEC });
    return combined;
  } catch (err) {
    console.error(`Search error for "${cleanQuery}":`, err);
    return catalogMatches;
  }
}

/**
 * Fetch detailed stats and historical chart for a ticker.
 */
export async function getTickerDetails(
  symbol: string,
  range: '1d' | '5d' | '1mo' | '6mo' | '1y' | '5y' = '1mo'
): Promise<TickerDetails | null> {
  const cleanSymbol = symbol.trim().toUpperCase();
  if (!cleanSymbol) return null;

  const cacheKey = `details:${cleanSymbol}:${range}`;
  const cached = await kvGet<TickerDetails>(cacheKey);
  if (cached) {
    // The chart may be ten minutes old, but the extended-session badge must not
    // be: the quote is re-resolved (30 s KV cache) and swapped into the payload
    // so a cached chart can never freeze the pre-market / after-hours figure.
    const freshQuote = await fetchQuoteWithClient(createYahooFinanceClient(), cleanSymbol);
    return freshQuote ? { ...cached, quote: freshQuote } : cached;
  }

  try {
    // A single request-scoped client serves the quote, the chart and the
    // consensus lookup below, so the crumb is fetched at most once per request.
    const yf = createYahooFinanceClient();

    const quote = await fetchQuoteWithClient(yf, cleanSymbol);
    if (!quote) return null;

    let interval: '2m' | '15m' | '1d' | '1wk' | '1mo' = '1d';
    let startDate = new Date();

    if (range === '1d') {
      startDate.setDate(startDate.getDate() - 1);
      interval = '15m';
    } else if (range === '5d') {
      startDate.setDate(startDate.getDate() - 5);
      interval = '15m';
    } else if (range === '1mo') {
      startDate.setMonth(startDate.getMonth() - 1);
      interval = '1d';
    } else if (range === '6mo') {
      startDate.setMonth(startDate.getMonth() - 6);
      interval = '1d';
    } else if (range === '1y') {
      startDate.setFullYear(startDate.getFullYear() - 1);
      interval = '1wk';
    } else if (range === '5y') {
      startDate.setFullYear(startDate.getFullYear() - 5);
      interval = '1mo';
    }

    let chartPoints: ChartPoint[] = [];

    // Attempt chart fetch via yf
    try {
      const chartRes = await yf.chart(cleanSymbol, {
        period1: startDate.toISOString().split('T')[0],
        interval: interval as any,
      });

      if (chartRes && chartRes.quotes && chartRes.quotes.length > 0) {
        chartPoints = chartRes.quotes
          .filter((pt: any) => pt.close !== null && pt.close !== undefined)
          .map((pt: any) => {
            const d = new Date(pt.date);
            return {
              date: range === '1d' || range === '5d'
                ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                : d.toLocaleDateString([], { month: 'short', day: 'numeric', year: range === '5y' ? '2-digit' : undefined }),
              timestamp: d.getTime(),
              close: Number(pt.close.toFixed(2)),
              open: pt.open ? Number(pt.open.toFixed(2)) : undefined,
              high: pt.high ? Number(pt.high.toFixed(2)) : undefined,
              low: pt.low ? Number(pt.low.toFixed(2)) : undefined,
              volume: pt.volume ?? undefined,
            };
          });
      }
    } catch (chartErr) {
      console.warn(`Chart fetch warning for ${cleanSymbol}:`, chartErr);
    }

    // Direct fallback for chart if yf.chart was empty
    if (chartPoints.length === 0) {
      try {
        const directRes = await fetch(
          `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(cleanSymbol)}?range=${range}&interval=${interval}`,
          {
            headers: { 'User-Agent': 'Mozilla/5.0' },
          }
        );
        if (directRes.ok) {
          const directJson = await directRes.json();
          const r = directJson.chart?.result?.[0];
          const timestamps = r?.timestamp || [];
          const closes = r?.indicators?.quote?.[0]?.close || [];
          chartPoints = timestamps
            .map((t: number, i: number) => {
              const d = new Date(t * 1000);
              return {
                date: range === '1d' || range === '5d'
                  ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                  : d.toLocaleDateString([], { month: 'short', day: 'numeric' }),
                timestamp: t * 1000,
                close: closes[i] ? Number(closes[i].toFixed(2)) : null,
              };
            })
            .filter((p: any) => p.close !== null);
        }
      } catch (directErr) {
        console.warn(`Direct chart fallback warning for ${cleanSymbol}:`, directErr);
      }
    }

    // Fetch consensus earnings estimates & forward multiples
    let forwardConsensus: ForwardConsensusData | undefined = undefined;
    try {
      const summary = await yf.quoteSummary(cleanSymbol, {
        modules: ['earningsTrend', 'defaultKeyStatistics', 'price'],
      });

      // Analyst EPS estimates are expressed in the listing (possibly minor)
      // currency: normalize them to match our already-normalized quote price.
      const estFactor = normalizeCurrency(summary?.price?.currency || quote.currency).factor;
      const rawForwardEps = summary?.defaultKeyStatistics?.forwardEps;
      const forwardEps =
        rawForwardEps !== null && rawForwardEps !== undefined ? Number(rawForwardEps) / estFactor : null;
      const trends = summary?.earningsTrend?.trend || [];
      const currentPrice = quote.price;

      const estimates: EarningsEstimatePeriod[] = [];

      for (const t of trends) {
        if (!t.period) continue;
        const est = t.earningsEstimate;
        if (!est || est.avg === null || est.avg === undefined) continue;

        let periodLabel = t.period;
        let year: number | undefined = undefined;
        if (t.endDate) {
          const d = new Date(t.endDate);
          year = d.getFullYear();
        }

        if (t.period === '0y') {
          periodLabel = year ? `FY ${year} (Current FY0)` : 'Current Year (FY0)';
        } else if (t.period === '+1y') {
          periodLabel = year ? `FY ${year} (Next FY1)` : 'Next Year (FY+1)';
        } else if (t.period === '0q') {
          periodLabel = 'Current Quarter (Q0)';
        } else if (t.period === '+1q') {
          periodLabel = 'Next Quarter (Q+1)';
        }

        const avgEps = est.avg !== null && est.avg !== undefined ? Number((Number(est.avg) / estFactor).toFixed(2)) : null;
        const lowEps = est.low !== null && est.low !== undefined ? Number((Number(est.low) / estFactor).toFixed(2)) : null;
        const highEps = est.high !== null && est.high !== undefined ? Number((Number(est.high) / estFactor).toFixed(2)) : null;
        const impliedForwardPE =
          avgEps && avgEps > 0 && currentPrice > 0 ? Number((currentPrice / avgEps).toFixed(2)) : null;

        estimates.push({
          period: t.period,
          periodLabel,
          endDate: t.endDate ? new Date(t.endDate).toISOString().split('T')[0] : undefined,
          year,
          avgEps,
          lowEps,
          highEps,
          numberOfAnalysts: est.numberOfAnalysts ?? null,
          growth: est.growth !== null && est.growth !== undefined ? Number((est.growth * 100).toFixed(1)) : null,
          currency: quote.currency || 'USD',
          impliedForwardPE,
          upRevisions30d: t.epsRevisions?.upLast30days ?? null,
          downRevisions30d: t.epsRevisions?.downLast30days ?? null,
        });
      }

      if (estimates.length > 0 || forwardEps !== null) {
        forwardConsensus = {
          forwardEps: forwardEps !== null ? Number(forwardEps.toFixed(2)) : null,
          forwardPE: quote.forwardPE,
          primaryHorizon: 'Next Fiscal Year (FY+1)',
          sourceDescription:
            'Consensus aggregated from sell-side equity research analysts (Goldman Sachs, Morgan Stanley, JPMorgan, BNP Paribas, Kepler Cheuvreux, etc.) compiled by Refinitiv/LSEG and S&P Global.',
          estimates,
        };
      }
    } catch (summaryErr) {
      console.warn(`Summary modules fetch warning for ${cleanSymbol}:`, summaryErr);
    }

    const details: TickerDetails = {
      quote,
      chart: chartPoints,
      forwardConsensus,
    };

    // Only persist to KV when the upstream actually returned a usable series.
    // Caching a degraded payload (empty chart) would keep serving a blank chart
    // for the whole TTL window, so a single transient upstream failure would
    // survive long after Yahoo Finance had recovered. Skipping the write lets
    // the next request hit the network again.
    if (chartPoints.length > 0) {
      await kvPut(cacheKey, details, { expirationTtl: CHART_CACHE_TTL_SEC });
    } else {
      console.warn(
        `Empty chart series for ${cleanSymbol} (${range}); serving uncached so the next attempt retries upstream`
      );
    }

    return details;
  } catch (err) {
    console.error(`Details fetch error for ${cleanSymbol}:`, err);
    return null;
  }
}
