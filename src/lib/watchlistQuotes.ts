// Attach freshly fetched quotes to watchlist rows.
//
// The quote stored with a row (D1 `quote_json` or the IndexedDB mirror) is a
// snapshot taken when the ticker was added. Serving it as a fallback when Yahoo
// does not answer made the UI replay values from days or weeks earlier - most
// visibly the pre-market / after-hours percentage, the only figure that still
// moves while the regular session is closed. A missing quote therefore stays
// missing for that cycle: the row shows no price rather than a fake one.
import type { TickerQuote, UserTicker } from './types';

export function attachQuotes(
  tickers: UserTicker[],
  quotes: Record<string, TickerQuote> | null | undefined
): UserTicker[] {
  const bySymbol = new Map(
    Object.entries(quotes ?? {}).map(([symbol, quote]) => [symbol.toUpperCase(), quote])
  );
  return tickers.map((ticker) => ({
    ...ticker,
    quote: bySymbol.get(ticker.symbol.toUpperCase()) ?? null,
  }));
}
