import { NextRequest, NextResponse } from 'next/server';
import { clearSession } from '@/lib/session';
import { assertSameOrigin } from '@/lib/sameOrigin';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const originError = assertSameOrigin(request);
  if (originError) return originError;

  try {
    await clearSession();
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Logout error:', err);
    return NextResponse.json({ error: 'Failed to log out' }, { status: 500 });
  }
}
