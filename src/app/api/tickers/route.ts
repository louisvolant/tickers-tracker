import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/session';
import { getQuote, getBatchQuotes } from '@/lib/yahooFinance';
import { UserTicker } from '@/lib/types';
import { ISO_FIAT_CURRENCIES } from '@/lib/currencies';
import { parseAlertThreshold, validateAlertPair } from '@/lib/alerts';
import { clearTickerAlertState } from '@/lib/alertStore';
import { assertSameOrigin } from '@/lib/sameOrigin';
import {
  getWatchlistRepository,
  nextTickerOrder,
  TickerAlreadyExistsError,
} from '@/lib/tickerStore';

export const runtime = 'nodejs';

/**
 * Validate an optional currency code, returning the normalized uppercase code
 * or null when missing/invalid.
 */
function parseTrackingCurrency(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const code = value.trim().toUpperCase();
  return ISO_FIAT_CURRENCIES.has(code) ? code : null;
}

/**
 * Strict variant used for alert thresholds: an invalid code is a client error,
 * not a silent fallback to the listing currency (which would move the threshold
 * onto a different scale).
 */
function parseAlertCurrency(value: unknown): { valid: boolean; code: string | null } {
  if (value === undefined) return { valid: true, code: null };
  if (value === null || value === '') return { valid: true, code: null };
  if (typeof value !== 'string') return { valid: false, code: null };
  const code = value.trim().toUpperCase();
  return { valid: ISO_FIAT_CURRENCIES.has(code), code };
}

/**
 * GET /api/tickers - Retrieve authenticated user's tickers with live quotes
 */
export async function GET(request: NextRequest) {
  const originError = assertSameOrigin(request);
  if (originError) return originError;

  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const tickers = await getWatchlistRepository().list(user.id);

    if (tickers.length === 0) {
      return NextResponse.json({ tickers: [] });
    }

    // Enrich with quotes
    const symbols = tickers.map((t) => t.symbol);
    const quotes = await getBatchQuotes(symbols);

    const enrichedTickers = tickers.map((t) => ({
      ...t,
      quote: quotes[t.symbol.toUpperCase()] || t.quote || null,
    }));

    return NextResponse.json({ tickers: enrichedTickers });
  } catch (err) {
    console.error('Error fetching user tickers:', err);
    return NextResponse.json({ error: 'Failed to fetch tickers' }, { status: 500 });
  }
}

/**
 * POST /api/tickers - Add a new ticker to user's watchlist
 */
export async function POST(request: NextRequest) {
  const originError = assertSameOrigin(request);
  if (originError) return originError;

  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { symbol, name, trackingValue, trackingCurrency, notes } = await request.json();

    if (!symbol || typeof symbol !== 'string') {
      return NextResponse.json({ error: 'Symbol is required' }, { status: 400 });
    }

    const cleanSymbol = symbol.trim().toUpperCase();
    let parsedTrackingValue: number | null = null;
    if (trackingValue !== undefined && trackingValue !== null && trackingValue !== '') {
      const val = Number(trackingValue);
      if (!isNaN(val) && val > 0) {
        parsedTrackingValue = Number(val.toFixed(4));
      }
    }

    // Verify ticker exists via quote
    const quote = await getQuote(cleanSymbol);
    if (!quote) {
      return NextResponse.json({ error: `Could not find ticker symbol "${cleanSymbol}"` }, { status: 404 });
    }

    const repo = getWatchlistRepository();
    const tickers = await repo.list(user.id);

    // Check if symbol already in watchlist
    const existingIndex = tickers.findIndex((t) => t.symbol.toUpperCase() === cleanSymbol);
    if (existingIndex !== -1) {
      return NextResponse.json({ error: `Ticker ${cleanSymbol} is already in your watchlist` }, { status: 409 });
    }

    const newTicker: UserTicker = {
      id: 'tck_' + crypto.randomUUID().replace(/-/g, ''),
      symbol: cleanSymbol,
      name: name || quote.name || cleanSymbol,
      trackingValue: parsedTrackingValue !== null ? Number(parsedTrackingValue.toFixed(4)) : null,
      trackingCurrency: parseTrackingCurrency(trackingCurrency),
      notes: typeof notes === 'string' ? notes.trim() : '',
      order: nextTickerOrder(tickers),
      createdAt: Date.now(),
      quote,
      // Persisted separately from the quote so the alert scanner can decide
      // whether the venue is open without calling Yahoo for a closed market.
      exchangeTimezone: quote.exchangeTimezone ?? null,
    };

    try {
      await repo.add(user.id, newTicker);
    } catch (err) {
      // The unique (user_id, symbol) index catches concurrent adds that both
      // passed the read above.
      if (err instanceof TickerAlreadyExistsError) {
        return NextResponse.json({ error: `Ticker ${cleanSymbol} is already in your watchlist` }, { status: 409 });
      }
      throw err;
    }

    return NextResponse.json({ ticker: newTicker }, { status: 201 });
  } catch (err) {
    console.error('Error adding ticker:', err);
    return NextResponse.json({ error: 'Failed to add ticker' }, { status: 500 });
  }
}

/**
 * PATCH /api/tickers - Update tracking value or notes for a ticker
 */
export async function PATCH(request: NextRequest) {
  const originError = assertSameOrigin(request);
  if (originError) return originError;

  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const {
      id,
      trackingValue,
      trackingCurrency,
      notes,
      alertHigh,
      alertLow,
      alertCurrency,
      alertHighSource,
      alertLowSource,
    } = await request.json();

    if (!id || typeof id !== 'string') {
      return NextResponse.json({ error: 'Ticker ID is required' }, { status: 400 });
    }

    const repo = getWatchlistRepository();
    const ticker = await repo.find(user.id, id);

    if (!ticker) {
      return NextResponse.json({ error: 'Ticker not found' }, { status: 404 });
    }

    if (trackingValue !== undefined) {
      if (trackingValue === null || trackingValue === '') {
        ticker.trackingValue = null;
      } else {
        const parsed = Number(trackingValue);
        if (!isNaN(parsed) && parsed > 0) {
          ticker.trackingValue = Number(parsed.toFixed(4));
        }
      }
    }

    if (trackingCurrency !== undefined) {
      ticker.trackingCurrency = parseTrackingCurrency(trackingCurrency);
    }

    if (notes !== undefined && typeof notes === 'string') {
      ticker.notes = notes.trim();
    }

    // --- Price alerts -------------------------------------------------------
    // Alerts are opt-in per ticker: nothing here is ever set by the add flow, so
    // a new watchlist entry never notifies until the user enables it explicitly.
    const parsedHigh = parseAlertThreshold(alertHigh);
    const parsedLow = parseAlertThreshold(alertLow);

    if (!parsedHigh.valid || !parsedLow.valid) {
      return NextResponse.json(
        { error: 'Alert thresholds must be positive numbers' },
        { status: 400 }
      );
    }

    const parsedCurrency = parseAlertCurrency(alertCurrency);
    if (!parsedCurrency.valid) {
      return NextResponse.json({ error: 'Unsupported alert currency' }, { status: 400 });
    }

    const nextHigh = parsedHigh.provided ? parsedHigh.value : ticker.alertHigh ?? null;
    const nextLow = parsedLow.provided ? parsedLow.value : ticker.alertLow ?? null;
    // An omitted currency keeps the stored one; an explicit null resets it to
    // the listing currency.
    const nextCurrency =
      alertCurrency === undefined ? ticker.alertCurrency ?? null : parsedCurrency.code;

    const pairError = validateAlertPair(nextHigh, nextLow);
    if (pairError) {
      return NextResponse.json({ error: pairError }, { status: 400 });
    }

    const alertsTouched =
      parsedHigh.provided || parsedLow.provided || alertCurrency !== undefined;
    const alertsChanged =
      alertsTouched &&
      (nextHigh !== (ticker.alertHigh ?? null) ||
        nextLow !== (ticker.alertLow ?? null) ||
        nextCurrency !== (ticker.alertCurrency ?? null));

    if (alertsTouched) {
      ticker.alertHigh = nextHigh;
      ticker.alertLow = nextLow;
      ticker.alertCurrency = nextCurrency;

      // Only rewrite a source when its threshold was part of this request:
      // changing just the currency must not turn a seeded "ath" into "custom".
      if (parsedHigh.provided || alertHighSource !== undefined) {
        ticker.alertHighSource =
          nextHigh === null ? undefined : alertHighSource === 'ath' ? 'ath' : 'custom';
      }
      if (parsedLow.provided || alertLowSource !== undefined) {
        ticker.alertLowSource =
          nextLow === null ? undefined : alertLowSource === 'atl' ? 'atl' : 'custom';
      }

      // Persist the venue timezone alongside the thresholds: the scanner uses it
      // to skip closed markets without a quote request.
      if (!ticker.exchangeTimezone && ticker.quote?.exchangeTimezone) {
        ticker.exchangeTimezone = ticker.quote.exchangeTimezone;
      }

      ticker.alertSetAt = Date.now();
    }

    if (alertsChanged) {
      // Delete the arming state instead of resetting it: the next scan will run
      // the "first evaluation" path, arm against the live quote and its FX rate,
      // and never notify on save.
      await clearTickerAlertState(user.id, ticker.id);
    }

    await repo.update(user.id, ticker);

    return NextResponse.json({ ticker });
  } catch (err) {
    console.error('Error updating ticker:', err);
    return NextResponse.json({ error: 'Failed to update ticker' }, { status: 500 });
  }
}

/**
 * DELETE /api/tickers - Remove a ticker from watchlist
 */
export async function DELETE(request: NextRequest) {
  const originError = assertSameOrigin(request);
  if (originError) return originError;

  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json({ error: 'Ticker ID is required' }, { status: 400 });
    }

    const repo = getWatchlistRepository();
    const removed = await repo.remove(user.id, id);

    if (!removed) {
      return NextResponse.json({ error: 'Ticker not found' }, { status: 404 });
    }

    // Re-index orders so the remaining positions stay contiguous.
    const remaining = await repo.list(user.id);
    await repo.reorder(user.id, remaining.map((ticker) => ticker.id));

    // The arming state would otherwise outlive the ticker and resurface if the
    // same ticker were added back later with a different configuration.
    await clearTickerAlertState(user.id, id);

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Error deleting ticker:', err);
    return NextResponse.json({ error: 'Failed to delete ticker' }, { status: 500 });
  }
}
