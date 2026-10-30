// Idempotent KV → D1 watchlist migration.
//
// The backfill never deletes KV. It inserts rows with `INSERT OR IGNORE`,
// marks each user as migrated, and can be run as many times as needed. The
// verifier then compares every KV ticker with its D1 row and returns counters
// only; the operator switches TICKER_BACKEND=d1 once it reports zero
// mismatches.
//
// Legacy KV user ids can differ from the current D1 account id when an account
// was recreated after the account migration. The resolver maps such a key to
// the D1 user with the same email, so the watchlist is imported into the live
// account instead of failing on the users(id) foreign key.

import { kvGet, kvListAll } from './kv';
import type { UserTicker } from './types';
import {
  TICKERS_PREFIX,
  type WatchlistEntry,
  type WatchlistRepository,
  tickersEquivalent,
} from './tickerStore';

export type TickerUserResolver = (legacyUserId: string) => Promise<string | null>;

const identityResolver: TickerUserResolver = async (legacyUserId) => legacyUserId;

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
  remappedKeys: number;
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
  remappedKeys: number;
  /** Matches made by symbol on a remapped legacy key. */
  symbolMatches: number;
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
  source: TickerMigrationSource = kvTickerMigrationSource,
  resolveUserId: TickerUserResolver = identityResolver
): Promise<TickerBackfillResult> {
  let scannedKeys = 0;
  let scannedTickers = 0;
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  let remappedKeys = 0;

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
      remappedKeys: 0,
      complete: false,
    };
  }

  for (const key of keys) {
    scannedKeys++;
    const legacyUserId = userIdFromKey(key);

    try {
      const userId = await resolveUserId(legacyUserId);
      if (!userId) {
        // No D1 account owns this legacy key. It is usually an orphan left by a
        // deleted account; failing closed lets the operator inspect it instead
        // of silently dropping or resurrecting someone's watchlist.
        throw new Error('No D1 user matches this legacy watchlist key');
      }
      if (userId !== legacyUserId) remappedKeys++;

      const tickers = await source.getTickers(legacyUserId);
      scannedTickers += tickers.length;

      const result = await repo.importMany(userId, tickers);
      imported += result.imported;
      skipped += result.skipped;
      await repo.markMigrated(userId);
    } catch (err) {
      failed++;
      // The key contains a user id, not an email or a symbol; keep the log
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
    remappedKeys,
    complete: failed === 0,
  };
}

/**
 * Compare every KV ticker with D1. Same-id keys are compared field by field.
 * Remapped keys are compared by symbol: the live D1 row wins for duplicate
 * symbols, while symbols missing from D1 are reported as `missing`.
 */
export async function verifyTickers(
  repo: WatchlistRepository,
  source: TickerMigrationSource = kvTickerMigrationSource,
  resolveUserId: TickerUserResolver = identityResolver
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
      remappedKeys: 0,
      symbolMatches: 0,
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
      remappedKeys: 0,
      symbolMatches: 0,
      complete: false,
    };
  }

  let scannedTickers = 0;
  let failed = 0;
  let remappedKeys = 0;
  let matched = 0;
  let mismatches = 0;
  let missing = 0;
  let symbolMatches = 0;

  // Every KV id that maps to a D1 user, so D1-only rows can be counted without
  // treating duplicates from a remapped legacy key as extras.
  const kvIdsByTarget = new Map<string, Set<string>>();

  for (const key of keys) {
    const legacyUserId = userIdFromKey(key);
    let userId: string | null;

    try {
      userId = await resolveUserId(legacyUserId);
      if (!userId) {
        failed++;
        continue;
      }
    } catch (err) {
      failed++;
      console.error('Watchlist verification failed to resolve one user:', err);
      continue;
    }

    if (userId !== legacyUserId) remappedKeys++;

    let kvTickers: UserTicker[];
    try {
      kvTickers = await source.getTickers(legacyUserId);
    } catch (err) {
      failed++;
      console.error('Watchlist verification failed for one user:', err);
      continue;
    }

    scannedTickers += kvTickers.length;

    const ids = kvIdsByTarget.get(userId) ?? new Set<string>();
    for (const ticker of kvTickers) ids.add(ticker.id);
    kvIdsByTarget.set(userId, ids);

    const d1Tickers = d1ByUser.get(userId) ?? [];

    if (userId === legacyUserId) {
      const d1ById = new Map(d1Tickers.map((ticker) => [ticker.id, ticker]));
      for (const kvTicker of kvTickers) {
        const d1Ticker = d1ById.get(kvTicker.id);
        if (!d1Ticker) {
          missing++;
          mismatches++;
        } else if (tickersEquivalent(kvTicker, d1Ticker)) {
          matched++;
        } else {
          mismatches++;
        }
      }
    } else {
      const d1BySymbol = new Map(
        d1Tickers.map((ticker) => [ticker.symbol.toUpperCase(), ticker])
      );
      for (const kvTicker of kvTickers) {
        if (d1BySymbol.has(kvTicker.symbol.toUpperCase())) {
          matched++;
          symbolMatches++;
        } else {
          missing++;
          mismatches++;
        }
      }
    }
  }

  let extraRows = 0;
  for (const [userId, d1Tickers] of d1ByUser) {
    const kvIds = kvIdsByTarget.get(userId) ?? new Set<string>();
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
    remappedKeys,
    symbolMatches,
    complete: failed === 0 && mismatches === 0,
  };
}
