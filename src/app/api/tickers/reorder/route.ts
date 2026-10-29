import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/session';
import { kvGet, kvPut } from '@/lib/kv';
import { UserTicker } from '@/lib/types';
import { assertSameOrigin } from '@/lib/sameOrigin';

export const runtime = 'nodejs';

/**
 * POST /api/tickers/reorder - Update order of tickers in user's watchlist
 */
export async function POST(request: NextRequest) {
  const originError = assertSameOrigin(request);
  if (originError) return originError;

  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { orderedIds } = await request.json();

    if (!Array.isArray(orderedIds) || orderedIds.some((id) => typeof id !== 'string')) {
      return NextResponse.json({ error: 'Invalid input: orderedIds must be an array of ticker IDs' }, { status: 400 });
    }

    const tickersKey = `user:tickers:${user.id}`;
    const tickers = (await kvGet<UserTicker[]>(tickersKey)) || [];

    const tickerMap = new Map(tickers.map((t) => [t.id, t]));
    const reordered: UserTicker[] = [];

    // Map according to requested orderedIds
    orderedIds.forEach((id, index) => {
      const item = tickerMap.get(id);
      if (item) {
        item.order = index;
        reordered.push(item);
        tickerMap.delete(id);
      }
    });

    // Append any tickers not explicitly in orderedIds to preserve data integrity
    for (const remaining of tickerMap.values()) {
      remaining.order = reordered.length;
      reordered.push(remaining);
    }

    await kvPut(tickersKey, reordered);

    return NextResponse.json({ success: true, tickers: reordered });
  } catch (err) {
    console.error('Error reordering tickers:', err);
    return NextResponse.json({ error: 'Failed to reorder tickers' }, { status: 500 });
  }
}
