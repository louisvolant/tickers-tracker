import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser, setSessionUser } from '@/lib/session';
import { ISO_FIAT_CURRENCIES } from '@/lib/currencies';
import { getUserRepository } from '@/lib/users';
import { assertSameOrigin } from '@/lib/sameOrigin';

export const runtime = 'nodejs';

/**
 * PATCH /api/auth/preferences - Update the user's preferred reference currency.
 */
export async function PATCH(request: NextRequest) {
  const originError = assertSameOrigin(request);
  if (originError) return originError;

  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    let preferredCurrency: unknown;
    try {
      ({ preferredCurrency } = await request.json());
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    if (typeof preferredCurrency !== 'string' || !ISO_FIAT_CURRENCIES.has(preferredCurrency.toUpperCase())) {
      return NextResponse.json({ error: 'Invalid currency code' }, { status: 400 });
    }

    const code = preferredCurrency.toUpperCase();

    const repo = getUserRepository();
    const user = await repo.findById(sessionUser.id);
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    await repo.updatePreferredCurrency(user.id, code);

    const updated = { ...sessionUser, preferredCurrency: code };
    await setSessionUser(updated);

    return NextResponse.json({ user: updated });
  } catch (err) {
    console.error('Error updating preferences:', err);
    return NextResponse.json({ error: 'Failed to update preferences' }, { status: 500 });
  }
}
