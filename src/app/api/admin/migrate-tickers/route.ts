import { NextRequest, NextResponse } from 'next/server';
import { getEnvVar } from '@/lib/env';
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
  if (!repo) {
    return NextResponse.json(
      { error: 'The D1 binding is not available' },
      { status: 503 }
    );
  }

  try {
    const verify = request.nextUrl.searchParams.get('verify') === '1';
    const result = verify
      ? await verifyTickers(repo, kvTickerMigrationSource)
      : await backfillTickers(repo, kvTickerMigrationSource);

    return NextResponse.json(
      { verify, ...result },
      { headers: { 'Cache-Control': 'private, no-store' } }
    );
  } catch (err) {
    console.error('Watchlist migration failed:', err);
    return NextResponse.json({ error: 'Migration failed' }, { status: 500 });
  }
}
