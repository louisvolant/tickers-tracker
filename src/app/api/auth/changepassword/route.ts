import { NextRequest, NextResponse } from 'next/server';
import { createSessionCookie, getSessionUser } from '@/lib/session';
import { verifyPassword, hashPassword, passwordMarker } from '@/lib/authCrypto';
import { getRequestOrigin } from '@/lib/env';
import { getUserRepository } from '@/lib/users';
import { assertSameOrigin } from '@/lib/sameOrigin';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const originError = assertSameOrigin(request);
  if (originError) return originError;

  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { currentPassword, newPassword } = await request.json();

    if (!currentPassword || !newPassword) {
      return NextResponse.json({ error: 'Current password and new password are required' }, { status: 400 });
    }

    if (typeof newPassword !== 'string' || newPassword.length < 6) {
      return NextResponse.json({ error: 'New password must be at least 6 characters' }, { status: 400 });
    }

    // Retrieve the account through the repository (D1 or KV depending on the
    // migration backend). The email fallback keeps legacy sessions working.
    const repo = getUserRepository();
    let user = await repo.findById(sessionUser.id);
    if (!user && sessionUser.email) {
      user = await repo.findByEmail(sessionUser.email);
    }
    if (!user || !user.hashedPassword) {
      return NextResponse.json(
        { error: 'Cannot change password for this account (e.g. Google-only account)' },
        { status: 400 }
      );
    }

    // Verify current password
    const isCurrentValid = await verifyPassword(currentPassword, user.hashedPassword);
    if (!isCurrentValid) {
      return NextResponse.json({ error: 'Current password is incorrect' }, { status: 403 });
    }

    // Hash and persist the new password. One row update in D1, instead of
    // rewriting the duplicated KV records.
    const newHashedPassword = await hashPassword(newPassword);
    await repo.updatePassword(user.id, newHashedPassword);

    // PBKDF2 re-salts on every write, so the marker embedded in existing
    // session tokens no longer matches the stored hash: every session issued
    // before this change is now invalid, on every device. Re-sign only the
    // session of the device that made this request, so the user is not
    // logged out of the browser that just proved knowledge of the old
    // password.
    const session = await createSessionCookie(
      {
        id: user.id,
        email: user.email,
        username: user.username,
        preferredCurrency: user.preferredCurrency,
      },
      getRequestOrigin(request).startsWith('https://'),
      passwordMarker(newHashedPassword)
    );

    const response = NextResponse.json({ success: true, message: 'Password updated successfully' });
    response.cookies.set(session.name, session.value, session.options);
    response.headers.set('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
    return response;
  } catch (err) {
    console.error('Change password error:', err);
    return NextResponse.json({ error: 'Failed to update password' }, { status: 500 });
  }
}
