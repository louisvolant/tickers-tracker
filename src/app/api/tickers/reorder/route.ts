import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/session';
import { assertSameOrigin } from '@/lib/sameOrigin';
import { getWatchlistRepository } from '@/lib/tickerStore';

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

    const reordered = await getWatchlistRepository().reorder(user.id, orderedIds);

    return NextResponse.json({ success: true, tickers: reordered });
  } catch (err) {
    console.error('Error reordering tickers:', err);
    return NextResponse.json({ error: 'Failed to reorder tickers' }, { status: 500 });
  }
}
