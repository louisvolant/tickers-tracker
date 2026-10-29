import { NextRequest, NextResponse } from 'next/server';
import { getBatchQuotes, getQuote } from '@/lib/yahooFinance';
import { assertSameOrigin } from '@/lib/sameOrigin';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const originError = assertSameOrigin(request);
  if (originError) return originError;

  const { searchParams } = new URL(request.url);
  const symbolsParam = searchParams.get('symbols') || searchParams.get('symbol');

  if (!symbolsParam) {
    return NextResponse.json({ error: 'Missing symbols query parameter' }, { status: 400 });
  }

  const symbols = symbolsParam.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

  if (symbols.length === 0) {
    return NextResponse.json({ quotes: {} });
  }

  try {
    if (symbols.length === 1) {
      const quote = await getQuote(symbols[0]);
      return NextResponse.json({
        quotes: quote ? { [quote.symbol]: quote } : {},
      });
    }

    const quotes = await getBatchQuotes(symbols);
    return NextResponse.json({ quotes });
  } catch (error) {
    console.error('Error in /api/tickers/quote:', error);
    return NextResponse.json({ error: 'Failed to fetch quotes' }, { status: 500 });
  }
}
