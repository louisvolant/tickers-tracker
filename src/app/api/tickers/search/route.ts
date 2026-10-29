import { NextRequest, NextResponse } from 'next/server';
import { searchTickers } from '@/lib/yahooFinance';
import { assertSameOrigin } from '@/lib/sameOrigin';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const originError = assertSameOrigin(request);
  if (originError) return originError;

  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q');

  if (!query || query.trim().length === 0) {
    return NextResponse.json({ results: [] });
  }

  try {
    const results = await searchTickers(query);
    return NextResponse.json({ results });
  } catch (error) {
    console.error('Error in /api/tickers/search:', error);
    return NextResponse.json({ error: 'Failed to search tickers' }, { status: 500 });
  }
}
