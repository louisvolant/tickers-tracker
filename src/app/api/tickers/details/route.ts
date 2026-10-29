import { NextRequest, NextResponse } from 'next/server';
import { getTickerDetails } from '@/lib/yahooFinance';
import { assertSameOrigin } from '@/lib/sameOrigin';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const originError = assertSameOrigin(request);
  if (originError) return originError;

  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get('symbol');
  const range = (searchParams.get('range') || '1mo') as '1d' | '5d' | '1mo' | '6mo' | '1y' | '5y';

  if (!symbol) {
    return NextResponse.json({ error: 'Missing symbol parameter' }, { status: 400 });
  }

  try {
    const details = await getTickerDetails(symbol, range);
    if (!details) {
      return NextResponse.json({ error: 'Ticker details not found' }, { status: 404 });
    }
    return NextResponse.json(details);
  } catch (error) {
    console.error(`Error in /api/tickers/details for ${symbol}:`, error);
    return NextResponse.json({ error: 'Failed to fetch ticker details' }, { status: 500 });
  }
}
