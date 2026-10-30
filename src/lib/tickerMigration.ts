// Idempotent KV → D1 watchlist migration.
//
// The backfill never deletes KV. It inserts rows with `INSERT OR IGNORE`,
// marks each user as migrated, and can be run as many times as needed. The
// verifier then compares every KV ticker with its D1 row field by field and
// returns counters only; the operator switches TICKER_BACKEND=d1 once it
// reports zero mismatches.

import { kvGet, kvListAll } from './kv';
import type { UserTicker } from './types';
import {
  TICKERS_PREFIX,
  type WatchlistEntry,
  type WatchlistRepository,
  tickersEquivalent,
} from './tickerStore';

export interface TickerMigrationSource {
  listKeys(): Promise<string[]>;
  getTickers(userId: string): Promise<UserTicker[]>;
}

export const kvTickerMigrationSource: TickerMigrationSource = {
  listKeys: () => kvListAll(TICKERS_PREFIX),
  getTickers: async (userId) =>
    (await kvGet<UserTicker[]>(`${TICKERS_PREFIX}${userId}`)) ?? [],
};

export interface TickerBackfillResult {
  scannedKeys: number;
  scannedTickers: number;
  imported: number;
  skipped: number;
  failed: number;
  complete: boolean;
}

export interface TickerVerificationResult {
  scannedKeys: number;
  scannedTickers: number;
  matched: number;
  mismatches: number;
  missing: number;
  extraRows: number;
  failed: number;
  complete: boolean;
}

function userIdFromKey(key: string): string {
  return key.slice(TICKERS_PREFIX.length);
}

function groupByUser(entries: WatchlistEntry[]): Map<string, UserTicker[]> {
  return new Map(entries.map((entry) => [entry.userId, entry.tickers]));
}

/** Copy every KV watchlist into D1. Safe to run repeatedly. */
export async function backfillTickers(
  repo: WatchlistRepository,
  source: TickerMigrationSource = kvTickerMigrationSource
): Promise<TickerBackfillResult> {
  let scannedKeys = 0;
  let scannedTickers = 0;
  let imported = 0;
  let skipped = 0;
  let failed = 0;

  let keys: string[] = [];
  try {
    keys = await source.listKeys();
  } catch (err) {
    console.error('Watchlist backfill could not list KV keys:', err);
    return {
      scannedKeys: 0,
      scannedTickers: 0,
      imported: 0,
      skipped: 0,
      failed: 1,
      complete: false,
    };
  }

  for (const key of keys) {
    scannedKeys++;
    try {
      const userId = userIdFromKey(key);
      const tickers = await source.getTickers(userId);
      scannedTickers += tickers.length;

      const result = await repo.importMany(userId, tickers);
      imported += result.imported;
      skipped += result.skipped;
      await repo.markMigrated(userId);
    } catch (err) {
      failed++;
      // The key contains the user id, not an email or a symbol; keep the log
      // useful without dumping watchlist contents.
      console.error('Watchlist backfill failed for one user:', err);
    }
  }

  return {
    scannedKeys,
    scannedTickers,
    imported,
    skipped,
    failed,
    complete: failed === 0,
  };
}

/**
 * Compare every KV ticker with D1. `mismatches` counts missing or different
 * rows; `extraRows` counts D1 rows that have no KV counterpart (normal for
 * tickers added after the cutover, suspicious before it).
 */
export async function verifyTickers(
  repo: WatchlistRepository,
  source: TickerMigrationSource = kvTickerMigrationSource
): Promise<TickerVerificationResult> {
  let keys: string[] = [];
  try {
    keys = await source.listKeys();
  } catch (err) {
    console.error('Watchlist verification could not list KV keys:', err);
    return {
      scannedKeys: 0,
      scannedTickers: 0,
      matched: 0,
      mismatches: 0,
      missing: 0,
      extraRows: 0,
      failed: 1,
      complete: false,
    };
  }

  let d1ByUser: Map<string, UserTicker[]>;
  try {
    d1ByUser = groupByUser(await repo.listAll());
  } catch (err) {
    console.error('Watchlist verification could not read D1:', err);
    return {
      scannedKeys: keys.length,
      scannedTickers: 0,
      matched: 0,
      mismatches: 0,
      missing: 0,
      extraRows: 0,
      failed: 1,
      complete: false,
    };
  }

  const kvByUser = new Map<string, UserTicker[]>();
  let scannedTickers = 0;
  let failed = 0;

  for (const key of keys) {
    const userId = userIdFromKey(key);
    try {
      const tickers = await source.getTickers(userId);
      kvByUser.set(userId, tickers);
      scannedTickers += tickers.length;
    } catch (err) {
      failed++;
      console.error('Watchlist verification failed for one user:', err);
    }
  }

  let matched = 0;
  let mismatches = 0;
  let missing = 0;

  for (const [userId, kvTickers] of kvByUser) {
    const d1ById = new Map((d1ByUser.get(userId) ?? []).map((ticker) => [ticker.id, ticker]));

    for (const kvTicker of kvTickers) {
      const d1Ticker = d1ById.get(kvTicker.id);
      if (!d1Ticker) {
        missing++;
        mismatches++;
        continue;
      }
      if (tickersEquivalent(kvTicker, d1Ticker)) matched++;
      else mismatches++;
    }
  }

  let extraRows = 0;
  for (const [userId, d1Tickers] of d1ByUser) {
    const kvIds = new Set((kvByUser.get(userId) ?? []).map((ticker) => ticker.id));
    for (const d1Ticker of d1Tickers) {
      if (!kvIds.has(d1Ticker.id)) extraRows++;
    }
  }

  return {
    scannedKeys: keys.length,
    scannedTickers,
    matched,
    mismatches,
    missing,
    extraRows,
    failed,
    complete: failed === 0 && mismatches === 0,
  };
}
