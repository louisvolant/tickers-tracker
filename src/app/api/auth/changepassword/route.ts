import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/session';
import { verifyPassword, hashPassword } from '@/lib/authCrypto';
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

    return NextResponse.json({ success: true, message: 'Password updated successfully' });
  } catch (err) {
    console.error('Change password error:', err);
    return NextResponse.json({ error: 'Failed to update password' }, { status: 500 });
  }
}
