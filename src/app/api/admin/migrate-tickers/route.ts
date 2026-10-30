import { NextRequest, NextResponse } from 'next/server';
import { getEnvVar } from '@/lib/env';
import { kvGet } from '@/lib/kv';
import type { UserRecord } from '@/lib/types';
import { getD1Binding } from '@/lib/users';
import { D1UserRepository } from '@/lib/users.d1';
import { getD1WatchlistRepository } from '@/lib/tickerStore';
import {
  backfillTickers,
  kvTickerMigrationSource,
  verifyTickers,
} from '@/lib/tickerMigration';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/admin/migrate-tickers        one-off KV → D1 backfill
 * POST /api/admin/migrate-tickers?verify=1  compare KV and D1, write nothing
 *
 * Temporary migration endpoint, gated by MIGRATION_SECRET. It is idempotent and
 * never deletes KV; keep the secret until the verifier reports
 * `complete: true` with `mismatches: 0` and the app has run on D1.
 */
export async function POST(request: NextRequest) {
  const secret = getEnvVar('MIGRATION_SECRET');
  if (!secret) {
    return NextResponse.json({ error: 'MIGRATION_SECRET is not configured' }, { status: 503 });
  }

  const provided = (request.headers.get('authorization') || '')
    .replace(/^Bearer\s+/i, '')
    .trim();
  if (provided !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const repo = getD1WatchlistRepository();
  const db = getD1Binding();
  if (!repo || !db) {
    return NextResponse.json(
      { error: 'The D1 binding is not available' },
      { status: 503 }
    );
  }

  // A legacy KV watchlist key can point at an account id that no longer exists
  // in D1 (typically after the account was recreated). Resolve it by email so
  // the existing tickers land on the live account instead of failing on the
  // users(id) foreign key.
  const users = new D1UserRepository(db);
  const resolveUserId = async (legacyUserId: string): Promise<string | null> => {
    if (await users.findById(legacyUserId)) return legacyUserId;

    const legacyUser = await kvGet<UserRecord>(`user:by-id:${legacyUserId}`);
    if (!legacyUser?.email) return null;

    const target = await users.findByEmail(legacyUser.email);
    return target?.id ?? null;
  };

  try {
    const verify = request.nextUrl.searchParams.get('verify') === '1';
    const result = verify
      ? await verifyTickers(repo, kvTickerMigrationSource, resolveUserId)
      : await backfillTickers(repo, kvTickerMigrationSource, resolveUserId);

    return NextResponse.json(
      { verify, ...result },
      { headers: { 'Cache-Control': 'private, no-store' } }
    );
  } catch (err) {
    console.error('Watchlist migration failed:', err);
    return NextResponse.json({ error: 'Migration failed' }, { status: 500 });
  }
}
