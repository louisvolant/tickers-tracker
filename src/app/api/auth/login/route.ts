import { NextRequest, NextResponse } from 'next/server';
import { verifyPassword } from '@/lib/authCrypto';
import { createSessionCookie } from '@/lib/session';
import { getRequestOrigin } from '@/lib/env';
import { getUserRepository } from '@/lib/users';
import { assertSameOrigin } from '@/lib/sameOrigin';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const originError = assertSameOrigin(request);
  if (originError) return originError;

  try {
    const { email, password } = await request.json();

    if (!email || !password) {
      return NextResponse.json({ error: 'Email and password are required' }, { status: 400 });
    }

    const cleanEmail = email.trim().toLowerCase();
    const repo = getUserRepository();
    const user = await repo.findByEmail(cleanEmail);

    if (!user || !user.hashedPassword) {
      return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 });
    }

    const isValid = await verifyPassword(password, user.hashedPassword);
    if (!isValid) {
      return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 });
    }

    // Best-effort: a local database that has not applied migration 0003 must
    // never turn a valid credential check into a failed sign-in.
    try {
      await repo.updateLastLogin(user.id, Date.now());
    } catch (err) {
      console.warn('Could not update last_login_at:', err);
    }

    const sessionUser = {
      id: user.id,
      email: user.email,
      username: user.username,
      preferredCurrency: user.preferredCurrency,
    };

    const session = await createSessionCookie(
      sessionUser,
      getRequestOrigin(request).startsWith('https://')
    );

    const response = NextResponse.json({ user: sessionUser });
    response.cookies.set(session.name, session.value, session.options);
    response.headers.set('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
    return response;
  } catch (err) {
    console.error('Login error:', err);
    return NextResponse.json({ error: 'Failed to sign in' }, { status: 500 });
  }
}
