import { NextRequest, NextResponse } from 'next/server';
import { hashPassword } from '@/lib/authCrypto';
import { createSessionCookie } from '@/lib/session';
import { ISO_FIAT_CURRENCIES } from '@/lib/currencies';
import { getRequestOrigin } from '@/lib/env';
import { EmailAlreadyExistsError } from '@/lib/users.types';
import { getUserRepository } from '@/lib/users';
import { assertSameOrigin } from '@/lib/sameOrigin';
import {
  isDisallowedEmailDomain,
  isEmailDomainPolicyBypassed,
} from '@/lib/emailDomainPolicy';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const originError = assertSameOrigin(request);
  if (originError) return originError;

  try {
    const { email, password, username, preferredCurrency } = await request.json();

    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return NextResponse.json({ error: 'Valid email address is required' }, { status: 400 });
    }

    if (!password || typeof password !== 'string' || password.length < 6) {
      return NextResponse.json({ error: 'Password must be at least 6 characters' }, { status: 400 });
    }

    const cleanEmail = email.trim().toLowerCase();

    // Public endpoint: no CSRF token (anyone could fetch one), but bots and
    // throwaway mailboxes must not create accounts. The e2e suite bypasses this
    // through E2E=1; production never does.
    if (!isEmailDomainPolicyBypassed() && isDisallowedEmailDomain(cleanEmail)) {
      return NextResponse.json({ error: 'Please use a real email address.' }, { status: 400 });
    }

    const cleanUsername = (username && typeof username === 'string' ? username.trim() : '') || cleanEmail.split('@')[0];

    const hashedPassword = await hashPassword(password);
    const userId = 'usr_' + crypto.randomUUID().replace(/-/g, '');

    const cleanPreferredCurrency =
      typeof preferredCurrency === 'string' && ISO_FIAT_CURRENCIES.has(preferredCurrency.toUpperCase())
        ? preferredCurrency.toUpperCase()
        : undefined;

    // The repository enforces email uniqueness (D1 unique index in the D1/dual
    // backends). There is deliberately no read-before-write check here: that is
    // what made concurrent registrations race on KV.
    try {
      await getUserRepository().create({
        id: userId,
        email: cleanEmail,
        username: cleanUsername,
        hashedPassword,
        createdAt: Date.now(),
        preferredCurrency: cleanPreferredCurrency,
      });
    } catch (err) {
      if (err instanceof EmailAlreadyExistsError) {
        return NextResponse.json(
          { error: 'An account with this email already exists' },
          { status: 409 }
        );
      }
      throw err;
    }

    const sessionUser = {
      id: userId,
      email: cleanEmail,
      username: cleanUsername,
      preferredCurrency: cleanPreferredCurrency,
    };

    const session = await createSessionCookie(
      sessionUser,
      getRequestOrigin(request).startsWith('https://')
    );

    const response = NextResponse.json({ user: sessionUser }, { status: 201 });
    response.cookies.set(session.name, session.value, session.options);
    response.headers.set('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
    return response;
  } catch (err) {
    console.error('Registration error:', err);
    return NextResponse.json({ error: 'Failed to create account' }, { status: 500 });
  }
}
