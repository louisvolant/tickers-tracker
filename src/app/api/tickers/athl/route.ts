import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/session';
import { getAthlSnapshot } from '@/lib/athl';
import { assertSameOrigin } from '@/lib/sameOrigin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/tickers/athl?symbol=AAPL
 *
 * All-time high/low freeze-frame used to prefill the price-alert thresholds.
 * Authenticated and uncached at the HTTP layer: the snapshot itself is cached in
 * KV for a day, so repeated clicks never turn into repeated Yahoo calls.
 */
export async function GET(request: NextRequest) {
  const originError = assertSameOrigin(request);
  if (originError) return originError;

  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const symbol = request.nextUrl.searchParams.get('symbol');
  if (!symbol || !symbol.trim()) {
    return NextResponse.json({ error: 'Missing symbol parameter' }, { status: 400 });
  }

  try {
    const snapshot = await getAthlSnapshot(symbol);
    if (!snapshot) {
      return NextResponse.json(
        { error: `No ATH/ATL history available for "${symbol.toUpperCase()}"` },
        { status: 404 }
      );
    }

    return NextResponse.json(snapshot, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (err) {
    console.error(`Error in /api/tickers/athl for ${symbol}:`, err);
    return NextResponse.json({ error: 'Failed to fetch ATH/ATL' }, { status: 500 });
  }
}
