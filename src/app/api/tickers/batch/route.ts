import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/session';
import { kvGet, kvPut } from '@/lib/kv';
import { getQuotesBatched } from '@/lib/yahooFinance';
import { UserTicker } from '@/lib/types';
import { MAX_BATCH_TICKERS, parseTickerSymbols } from '@/lib/batchTickers';
import { assertSameOrigin } from '@/lib/sameOrigin';

export const runtime = 'nodejs';

/**
 * POST /api/tickers/batch
 *
 * Add several symbols to the watchlist at once. Existing symbols are skipped,
 * unknown symbols are reported individually, and the watchlist is written once.
 *
 * Quotes are fetched with getQuotesBatched() (one Yahoo request per chunk) rather
 * than one getQuote() per symbol, so a 25-symbol paste stays cheap.
 */
export async function POST(request: NextRequest) {
  const originError = assertSameOrigin(request);
  if (originError) return originError;

  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json().catch(() => null);
    const raw = Array.isArray(body?.symbols)
      ? body.symbols.filter((value: unknown) => typeof value === 'string').join(',')
      : typeof body?.symbols === 'string'
        ? body.symbols
        : '';
    const symbols = parseTickerSymbols(raw);

    if (symbols.length === 0) {
      return NextResponse.json({ error: 'No valid ticker symbol provided' }, { status: 400 });
    }

    if (symbols.length > MAX_BATCH_TICKERS) {
      return NextResponse.json(
        { error: `Too many symbols. Maximum: ${MAX_BATCH_TICKERS}` },
        { status: 400 }
      );
    }

    const tickersKey = `user:tickers:${user.id}`;
    const tickers = (await kvGet<UserTicker[]>(tickersKey)) || [];
    const existing = new Set(tickers.map((ticker) => ticker.symbol.toUpperCase()));

    const skipped = symbols.filter((symbol) => existing.has(symbol));
    const toFetch = symbols.filter((symbol) => !existing.has(symbol));

    if (toFetch.length === 0) {
      return NextResponse.json(
        { added: [], skipped, failed: [] },
        { headers: { 'Cache-Control': 'private, no-store' } }
      );
    }

    const quotes = await getQuotesBatched(toFetch);
    const added: UserTicker[] = [];
    const failed: string[] = [];

    for (const symbol of toFetch) {
      const quote = quotes[symbol];
      if (!quote) {
        failed.push(symbol);
        continue;
      }

      added.push({
        id: 'tck_' + crypto.randomUUID().replace(/-/g, ''),
        symbol,
        name: quote.name || symbol,
        trackingValue: null,
        trackingCurrency: null,
        notes: '',
        order: tickers.length + added.length,
        createdAt: Date.now(),
        quote,
        exchangeTimezone: quote.exchangeTimezone ?? null,
      });
    }

    // One read-modify-write for the whole batch. A concurrent edit from another
    // tab is not merged (KV has no atomic append), which matches the single-add
    // path and is acceptable at this scale.
    if (added.length > 0) {
      await kvPut(tickersKey, [...tickers, ...added]);
    }

    return NextResponse.json(
      { added, skipped, failed },
      { headers: { 'Cache-Control': 'private, no-store' } }
    );
  } catch (err) {
    console.error('Error in /api/tickers/batch:', err);
    return NextResponse.json({ error: 'Failed to add tickers' }, { status: 500 });
  }
}
