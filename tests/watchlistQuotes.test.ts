import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { attachQuotes } from '../src/lib/watchlistQuotes';
import { TickerQuote, UserTicker } from '../src/lib/types';

const quote = (symbol: string, price: number): TickerQuote => ({
  symbol,
  name: symbol,
  price,
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
});

const ticker = (symbol: string, storedPrice: number): UserTicker => ({
  id: `tck_${symbol}`,
  symbol,
  name: symbol,
  trackingValue: 100,
  trackingCurrency: null,
  notes: 'keep me',
  order: 0,
  createdAt: 1,
  quote: quote(symbol, storedPrice),
});

describe('Watchlist quote attachment', () => {
  test('replaces the stored snapshot with the freshly fetched quote', () => {
    const [row] = attachQuotes([ticker('AAPL', 100)], { AAPL: quote('AAPL', 250) });
    assert.equal(row.quote?.price, 250);
  });

  test('drops the stored snapshot when the fetch returned nothing for that symbol', () => {
    // Regression: this fallback replayed a quote stored when the ticker was
    // added, so a Yahoo outage froze the price (and the extended badge) for days.
    const [row] = attachQuotes([ticker('AAPL', 100)], {});
    assert.equal(row.quote, null);
    assert.equal(row.symbol, 'AAPL');
    assert.equal(row.trackingValue, 100);
    assert.equal(row.notes, 'keep me');
  });

  test('tolerates a missing quote map entirely', () => {
    const [row] = attachQuotes([ticker('AAPL', 100)], null);
    assert.equal(row.quote, null);
  });

  test('matches symbols case-insensitively', () => {
    const [row] = attachQuotes([ticker('MC.PA', 100)], { 'mc.pa': quote('MC.PA', 388) });
    assert.equal(row.quote?.price, 388);
  });

  test('leaves rows whose symbol is absent from the fresh map without a price', () => {
    const rows = attachQuotes([ticker('AAPL', 100), ticker('MSFT', 200)], {
      MSFT: quote('MSFT', 300),
    });
    assert.equal(rows[0].quote, null);
    assert.equal(rows[1].quote?.price, 300);
  });
});
