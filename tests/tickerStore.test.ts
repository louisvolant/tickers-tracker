import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import type { UserTicker } from '../src/lib/types';
import { kvDelete, kvGet, kvPut } from '../src/lib/kv';
import {
  DualWatchlistRepository,
  D1WatchlistRepository,
  KvWatchlistRepository,
  TickerAlreadyExistsError,
  tickersEquivalent,
} from '../src/lib/tickerStore';
import {
  backfillTickers,
  verifyTickers,
  type TickerMigrationSource,
} from '../src/lib/tickerMigration';
import { createSqliteDatabase, SqliteD1 } from './helpers/sqliteD1';

const MIGRATIONS = ['0001_users.sql', '0002_tickers.sql', '0003_last_login_at.sql'];

function migratedDatabase() {
  const db = createSqliteDatabase();
  for (const file of MIGRATIONS) {
    db.exec(fs.readFileSync(path.join(process.cwd(), 'migrations', file), 'utf8'));
  }
  return db;
}

function addUser(db: ReturnType<typeof migratedDatabase>, id: string) {
  db.exec(
    `INSERT INTO users (id, email, username, created_at)
     VALUES ('${id}', '${id}@gmail.com', '${id}', 1)`
  );
}

function ticker(overrides: Partial<UserTicker> = {}): UserTicker {
  return {
    id: 'tck_1',
    symbol: 'AAPL',
    name: 'Apple Inc.',
    trackingValue: 200,
    trackingCurrency: 'USD',
    notes: 'core holding',
    order: 0,
    createdAt: 1000,
    exchangeTimezone: 'America/New_York',
    alertHigh: 300,
    alertLow: 100,
    alertCurrency: 'USD',
    alertHighSource: 'ath',
    alertLowSource: 'custom',
    alertSetAt: 2000,
    quote: {
      symbol: 'AAPL',
      name: 'Apple Inc.',
      price: 250,
      change: 1,
      changePercent: 0.4,
      currency: 'USD',
      trailingPE: 30,
      forwardPE: 28,
      marketCap: 3_000_000_000_000,
      dividendYield: 0.5,
      fiftyTwoWeekHigh: 300,
      fiftyTwoWeekLow: 150,
      epsTrailingTwelveMonths: 7,
      beta: 1.1,
      volume: 1_000_000,
      avgVolume: 2_000_000,
      exchange: 'NMS',
      quoteType: 'EQUITY',
      updatedAt: 3000,
      exchangeTimezone: 'America/New_York',
    },
    ...overrides,
  };
}

describe('D1 watchlist repository', () => {
  test('round-trips every ticker field, including the quote fallback', async () => {
    const db = migratedDatabase();
    addUser(db, 'usr_1');
    const repo = new D1WatchlistRepository(new SqliteD1(db));
    const original = ticker();

    await repo.add('usr_1', original);

    const [stored] = await repo.list('usr_1');
    assert.ok(tickersEquivalent(original, stored));
    assert.strictEqual(stored.quote?.price, 250);
    assert.strictEqual(stored.alertHigh, 300);
    assert.strictEqual(stored.order, 0);
  });

  test('enforces one row per user and symbol', async () => {
    const db = migratedDatabase();
    addUser(db, 'usr_1');
    const repo = new D1WatchlistRepository(new SqliteD1(db));

    await repo.add('usr_1', ticker({ id: 'a' }));
    await assert.rejects(
      () => repo.add('usr_1', ticker({ id: 'b', order: 1 })),
      TickerAlreadyExistsError
    );
  });

  test('updates and removes one row without touching the others', async () => {
    const db = migratedDatabase();
    addUser(db, 'usr_1');
    const repo = new D1WatchlistRepository(new SqliteD1(db));
    await repo.add('usr_1', ticker({ id: 'a' }));
    await repo.add('usr_1', ticker({ id: 'b', symbol: 'MSFT', order: 1 }));

    await repo.update('usr_1', ticker({ id: 'a', notes: 'updated' }));
    assert.strictEqual((await repo.find('usr_1', 'a'))?.notes, 'updated');

    assert.strictEqual(await repo.remove('usr_1', 'a'), true);
    assert.strictEqual(await repo.remove('usr_1', 'a'), false);
    assert.deepStrictEqual((await repo.list('usr_1')).map((t) => t.id), ['b']);
  });

  test('reorders requested ids and appends omitted tickers', async () => {
    const db = migratedDatabase();
    addUser(db, 'usr_1');
    const repo = new D1WatchlistRepository(new SqliteD1(db));
    await repo.add('usr_1', ticker({ id: 'a', order: 0 }));
    await repo.add('usr_1', ticker({ id: 'b', symbol: 'MSFT', order: 1 }));
    await repo.add('usr_1', ticker({ id: 'c', symbol: 'NVDA', order: 2 }));

    const reordered = await repo.reorder('usr_1', ['c', 'a']);

    assert.deepStrictEqual(reordered.map((t) => t.id), ['c', 'a', 'b']);
    assert.deepStrictEqual(reordered.map((t) => t.order), [0, 1, 2]);
  });

  test('imports idempotently and marks the user as migrated', async () => {
    const db = migratedDatabase();
    addUser(db, 'usr_1');
    const repo = new D1WatchlistRepository(new SqliteD1(db));

    assert.strictEqual(await repo.isMigrated('usr_1'), false);
    assert.deepStrictEqual(await repo.importMany('usr_1', [ticker()]), {
      imported: 1,
      skipped: 0,
    });
    await repo.markMigrated('usr_1');

    assert.deepStrictEqual(await repo.importMany('usr_1', [ticker()]), {
      imported: 0,
      skipped: 1,
    });
    assert.strictEqual(await repo.isMigrated('usr_1'), true);
  });

  test('returns armed watchlists for the scanner and every row for verification', async () => {
    const db = migratedDatabase();
    addUser(db, 'usr_1');
    const repo = new D1WatchlistRepository(new SqliteD1(db));
    await repo.add('usr_1', ticker({ id: 'armed' }));
    await repo.add(
      'usr_1',
      ticker({ id: 'plain', symbol: 'MSFT', order: 1, alertHigh: null, alertLow: null })
    );

    const scan = await repo.listAllForScan();
    assert.deepStrictEqual(scan.flatMap((entry) => entry.tickers.map((t) => t.id)), ['armed']);

    const all = await repo.listAll();
    assert.strictEqual(all.flatMap((entry) => entry.tickers).length, 2);
  });

  test('deleting a user cascades tickers and the migration marker', async () => {
    const db = migratedDatabase();
    addUser(db, 'usr_1');
    const repo = new D1WatchlistRepository(new SqliteD1(db));
    await repo.add('usr_1', ticker());
    await repo.markMigrated('usr_1');

    db.exec("DELETE FROM users WHERE id = 'usr_1'");

    assert.deepStrictEqual(await repo.list('usr_1'), []);
    assert.strictEqual(await repo.isMigrated('usr_1'), false);
  });
});

describe('KV → D1 watchlist migration', () => {
  function source(entries: Record<string, UserTicker[]>): TickerMigrationSource {
    return {
      listKeys: async () => Object.keys(entries).map((userId) => `user:tickers:${userId}`),
      getTickers: async (userId) => entries[userId] ?? [],
    };
  }

  test('backfills every key, then verifies field-by-field equality', async () => {
    const db = migratedDatabase();
    addUser(db, 'usr_1');
    addUser(db, 'usr_2');
    const repo = new D1WatchlistRepository(new SqliteD1(db));
    const kv = source({
      usr_1: [ticker({ id: 'a' }), ticker({ id: 'b', symbol: 'MSFT', order: 1 })],
      usr_2: [ticker({ id: 'c', symbol: 'NVDA' })],
    });

    const backfill = await backfillTickers(repo, kv);
    assert.deepStrictEqual(backfill, {
      scannedKeys: 2,
      scannedTickers: 3,
      imported: 3,
      skipped: 0,
      failed: 0,
      remappedKeys: 0,
      complete: true,
    });

    const verification = await verifyTickers(repo, kv);
    assert.strictEqual(verification.scannedTickers, 3);
    assert.strictEqual(verification.matched, 3);
    assert.strictEqual(verification.mismatches, 0);
    assert.strictEqual(verification.failed, 0);
    assert.strictEqual(verification.complete, true);

    // The backfill is idempotent: a second run imports nothing new.
    const second = await backfillTickers(repo, kv);
    assert.strictEqual(second.imported, 0);
    assert.strictEqual(second.skipped, 3);
    assert.strictEqual(second.complete, true);
  });

  test('imports a legacy key into the live account resolved by email', async () => {
    const db = migratedDatabase();
    addUser(db, 'usr_new');
    const repo = new D1WatchlistRepository(new SqliteD1(db));

    // The current account already has AAPL under its own id. The legacy key has
    // a stale AAPL id plus CW8.PA, which must not be lost.
    await repo.add('usr_new', ticker({ id: 'current-aapl', symbol: 'AAPL' }));
    const kv = source({
      usr_old: [
        ticker({ id: 'old-aapl', symbol: 'AAPL' }),
        ticker({ id: 'old-cw8', symbol: 'CW8.PA' }),
      ],
    });
    const resolve = async (legacyId: string) => (legacyId === 'usr_old' ? 'usr_new' : legacyId);

    const backfill = await backfillTickers(repo, kv, resolve);
    assert.strictEqual(backfill.remappedKeys, 1);
    assert.strictEqual(backfill.imported, 1); // CW8.PA; stale AAPL is skipped
    assert.strictEqual(backfill.skipped, 1);
    assert.strictEqual(backfill.failed, 0);
    assert.strictEqual(backfill.complete, true);

    const d1 = await repo.list('usr_new');
    assert.deepStrictEqual(d1.map((t) => t.symbol).sort(), ['AAPL', 'CW8.PA']);
    assert.deepStrictEqual(d1.map((t) => t.id).sort(), ['current-aapl', 'old-cw8']);

    const verification = await verifyTickers(repo, kv, resolve);
    assert.strictEqual(verification.remappedKeys, 1);
    assert.strictEqual(verification.symbolMatches, 2); // AAPL + CW8.PA
    assert.strictEqual(verification.missing, 0);
    assert.strictEqual(verification.mismatches, 0);
    assert.strictEqual(verification.extraRows, 1); // current-aapl is D1-only
    assert.strictEqual(verification.complete, true);
  });

  test('detects a changed row and a missing row', async () => {
    const db = migratedDatabase();
    addUser(db, 'usr_1');
    const repo = new D1WatchlistRepository(new SqliteD1(db));
    const kv = source({ usr_1: [ticker({ id: 'a' }), ticker({ id: 'b', symbol: 'MSFT' })] });

    await backfillTickers(repo, kv);
    await repo.update('usr_1', ticker({ id: 'a', notes: 'changed in D1' }));

    let verification = await verifyTickers(repo, kv);
    assert.strictEqual(verification.mismatches, 1);
    assert.strictEqual(verification.missing, 0);
    assert.strictEqual(verification.complete, false);

    await repo.remove('usr_1', 'b');
    verification = await verifyTickers(repo, kv);
    assert.strictEqual(verification.mismatches, 2);
    assert.strictEqual(verification.missing, 1);
    assert.strictEqual(verification.complete, false);
  });

  test('reports D1-only rows separately without failing the migration', async () => {
    const db = migratedDatabase();
    addUser(db, 'usr_1');
    const repo = new D1WatchlistRepository(new SqliteD1(db));
    const kv = source({ usr_1: [ticker({ id: 'a' })] });

    await backfillTickers(repo, kv);
    await repo.add('usr_1', ticker({ id: 'new', symbol: 'NVDA', order: 1 }));

    const verification = await verifyTickers(repo, kv);
    assert.strictEqual(verification.mismatches, 0);
    assert.strictEqual(verification.extraRows, 1);
    assert.strictEqual(verification.complete, true);
  });

  test('fails closed when a KV read throws', async () => {
    const db = migratedDatabase();
    addUser(db, 'usr_1');
    const repo = new D1WatchlistRepository(new SqliteD1(db));

    const verification = await verifyTickers(repo, {
      listKeys: async () => ['user:tickers:usr_1'],
      getTickers: async () => {
        throw new Error('KV unavailable');
      },
    });

    assert.strictEqual(verification.failed, 1);
    assert.strictEqual(verification.complete, false);
  });
});

describe('Dual watchlist transition', () => {
  test('lazily imports KV, mirrors writes, and does not resurrect deletes', async () => {
    const userId = `usr_dual_${Date.now()}`;
    const db = migratedDatabase();
    addUser(db, userId);

    const key = `user:tickers:${userId}`;
    await kvPut(key, [ticker({ id: 'a', order: 0 }), ticker({ id: 'b', symbol: 'MSFT', order: 1 })]);

    const dual = new DualWatchlistRepository(
      new D1WatchlistRepository(new SqliteD1(db)),
      new KvWatchlistRepository()
    );

    try {
      // The first read imports the whole KV array, not just one row.
      assert.deepStrictEqual((await dual.list(userId)).map((t) => t.id), ['a', 'b']);

      await dual.remove(userId, 'a');
      assert.deepStrictEqual((await dual.list(userId)).map((t) => t.id), ['b']);
      assert.deepStrictEqual(((await kvGet<UserTicker[]>(key)) ?? []).map((t) => t.id), ['b']);

      await dual.remove(userId, 'b');
      assert.deepStrictEqual(await dual.list(userId), []);
      assert.strictEqual(await kvGet(key), null);

      await dual.add(userId, ticker({ id: 'c', symbol: 'NVDA', order: 0 }));
      assert.deepStrictEqual((await dual.list(userId)).map((t) => t.id), ['c']);
      assert.deepStrictEqual(((await kvGet<UserTicker[]>(key)) ?? []).map((t) => t.id), ['c']);

      // The marker prevents a later empty D1 read from re-importing stale KV.
      await kvPut(key, [ticker({ id: 'stale', symbol: 'OLD' })]);
      await dual.deleteAll(userId);
      assert.deepStrictEqual(await dual.list(userId), []);
    } finally {
      await kvDelete(key);
    }
  });

  test('merges an unmigrated KV alert into the scan and imports it', async () => {
    const userId = `usr_dual_scan_${Date.now()}`;
    const db = migratedDatabase();
    addUser(db, userId);
    const key = `user:tickers:${userId}`;
    await kvPut(key, [ticker({ id: 'armed', alertHigh: 300 })]);

    const primary = new D1WatchlistRepository(new SqliteD1(db));
    const dual = new DualWatchlistRepository(primary, new KvWatchlistRepository());

    try {
      const entries = await dual.listAllForScan();
      assert.deepStrictEqual(entries.flatMap((entry) => entry.tickers.map((t) => t.id)), ['armed']);
      assert.strictEqual((await primary.list(userId)).length, 1);
    } finally {
      await kvDelete(key);
    }
  });
});
