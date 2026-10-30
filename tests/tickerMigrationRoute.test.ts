import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import type { UserTicker } from '../src/lib/types';
import { POST } from '../src/app/api/admin/migrate-tickers/route';
import { setRuntimeEnv } from '../src/lib/env';
import { D1WatchlistRepository } from '../src/lib/tickerStore';
import { createSqliteDatabase, SqliteD1 } from './helpers/sqliteD1';

/**
 * Minimal Workers KV binding for the migration route test. Values are stored as
 * JSON strings because the production binding is asked for `get(key, 'json')`.
 */
function fakeKv(seed: Record<string, unknown>) {
  const store = new Map<string, string>();
  for (const [key, value] of Object.entries(seed)) store.set(key, JSON.stringify(value));

  return {
    store,
    async get(key: string, type?: string) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list({ prefix }: { prefix?: string }) {
      return {
        keys: [...store.keys()]
          .filter((key) => !prefix || key.startsWith(prefix))
          .map((name) => ({ name })),
        list_complete: true,
        cursor: undefined,
      };
    },
  };
}

function ticker(): UserTicker {
  return {
    id: 'tck_route_1',
    symbol: 'AAPL',
    name: 'Apple Inc.',
    trackingValue: 200,
    order: 0,
    createdAt: 1000,
    exchangeTimezone: 'America/New_York',
    alertHigh: 300,
    quote: { price: 250, symbol: 'AAPL' } as any,
  };
}

function request(query = ''): NextRequest {
  return new NextRequest(`http://localhost:3000/api/admin/migrate-tickers${query}`, {
    method: 'POST',
    headers: { authorization: 'Bearer migration-test-secret' },
  });
}

describe('POST /api/admin/migrate-tickers', () => {
  test('backfills fake KV into fake D1, verifies it, and leaves KV untouched', async () => {
    const db = createSqliteDatabase();
    for (const file of ['0001_users.sql', '0002_tickers.sql', '0003_last_login_at.sql']) {
      db.exec(fs.readFileSync(path.join(process.cwd(), 'migrations', file), 'utf8'));
    }
    db.exec(
      "INSERT INTO users (id, email, username, created_at) VALUES ('usr_route', 'route@gmail.com', 'route', 1)"
    );

    const kv = fakeKv({ 'user:tickers:usr_route': [ticker()] });
    const d1 = new SqliteD1(db);
    setRuntimeEnv({ DB: d1, KV: kv, MIGRATION_SECRET: 'migration-test-secret' });

    try {
      const backfill = await POST(request());
      assert.strictEqual(backfill.status, 200);
      const backfillBody = await backfill.json();
      assert.strictEqual(backfillBody.verify, false);
      assert.strictEqual(backfillBody.scannedKeys, 1);
      assert.strictEqual(backfillBody.imported, 1);
      assert.strictEqual(backfillBody.failed, 0);
      assert.strictEqual(backfillBody.complete, true);

      const verify = await POST(request('?verify=1'));
      assert.strictEqual(verify.status, 200);
      const verifyBody = await verify.json();
      assert.strictEqual(verifyBody.verify, true);
      assert.strictEqual(verifyBody.mismatches, 0);
      assert.strictEqual(verifyBody.matched, 1);
      assert.strictEqual(verifyBody.complete, true);

      // The migration is additive: KV still holds the source data for rollback.
      assert.ok(kv.store.has('user:tickers:usr_route'));
    } finally {
      setRuntimeEnv(null);
    }
  });

  test('remaps an orphan legacy user id to the live D1 account by email', async () => {
    const db = createSqliteDatabase();
    for (const file of ['0001_users.sql', '0002_tickers.sql', '0003_last_login_at.sql']) {
      db.exec(fs.readFileSync(path.join(process.cwd(), 'migrations', file), 'utf8'));
    }
    db.exec(
      "INSERT INTO users (id, email, username, created_at) VALUES ('usr_new', 'legacy@gmail.com', 'legacy', 1)"
    );

    const kv = fakeKv({
      'user:by-id:usr_old': {
        id: 'usr_old',
        email: 'legacy@gmail.com',
        username: 'legacy',
        createdAt: 1,
      },
      'user:tickers:usr_old': [ticker()],
    });
    const d1 = new SqliteD1(db);
    setRuntimeEnv({ DB: d1, KV: kv, MIGRATION_SECRET: 'migration-test-secret' });

    try {
      const backfill = await POST(request());
      const backfillBody = await backfill.json();
      assert.strictEqual(backfillBody.remappedKeys, 1);
      assert.strictEqual(backfillBody.imported, 1);
      assert.strictEqual(backfillBody.failed, 0);
      assert.strictEqual(backfillBody.complete, true);

      const verify = await POST(request('?verify=1'));
      const verifyBody = await verify.json();
      assert.strictEqual(verifyBody.remappedKeys, 1);
      assert.strictEqual(verifyBody.missing, 0);
      assert.strictEqual(verifyBody.mismatches, 0);
      assert.strictEqual(verifyBody.complete, true);

      const stored = await new D1WatchlistRepository(d1).list('usr_new');
      assert.strictEqual(stored[0].symbol, 'AAPL');
    } finally {
      setRuntimeEnv(null);
    }
  });

  test('rejects a missing or wrong secret before touching D1', async () => {
    const db = createSqliteDatabase();
    for (const file of ['0001_users.sql', '0002_tickers.sql', '0003_last_login_at.sql']) {
      db.exec(fs.readFileSync(path.join(process.cwd(), 'migrations', file), 'utf8'));
    }
    setRuntimeEnv({ DB: new SqliteD1(db), KV: fakeKv({}), MIGRATION_SECRET: 'right-secret' });

    try {
      const wrong = await POST(
        new NextRequest('http://localhost:3000/api/admin/migrate-tickers', {
          method: 'POST',
          headers: { authorization: 'Bearer wrong-secret' },
        })
      );
      assert.strictEqual(wrong.status, 401);
    } finally {
      setRuntimeEnv(null);
    }
  });
});
