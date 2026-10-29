import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser, clearSession } from '@/lib/session';
import { kvDelete } from '@/lib/kv';
import { getUserRepository } from '@/lib/users';
import { assertSameOrigin } from '@/lib/sameOrigin';

export const runtime = 'nodejs';

async function handleDeleteAccount(request: NextRequest) {
  const originError = assertSameOrigin(request);
  if (originError) return originError;

  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const repo = getUserRepository();
    const user = await repo.findById(sessionUser.id);

    // Delete watchlist and per-user side data. Phase 4 will move these to D1
    // with ON DELETE CASCADE; until then they are still KV keys.
    await kvDelete(`user:tickers:${sessionUser.id}`);
    await kvDelete(`alert:state:${sessionUser.id}`);
    await kvDelete(`push:subs:${sessionUser.id}`);

    // Delete the account through the repository: D1 row in d1/dual mode, both
    // KV keys in kv/dual mode.
    await repo.delete(sessionUser.id);

    // Transition cleanup: in pure D1 mode the legacy KV keys are no longer
    // written by the repository, so remove them explicitly if they still exist.
    if (user?.email) {
      await kvDelete(`user:by-email:${user.email.toLowerCase()}`);
    }
    await kvDelete(`user:by-id:${sessionUser.id}`);

    // Clear session cookie
    await clearSession();

    return NextResponse.json({ success: true, message: 'Account deleted successfully' });
  } catch (err) {
    console.error('Delete account error:', err);
    return NextResponse.json({ error: 'Failed to delete account' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  return handleDeleteAccount(request);
}

export async function POST(request: NextRequest) {
  return handleDeleteAccount(request);
}
