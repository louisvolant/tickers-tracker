import { cookies } from 'next/headers';
import { passwordMarker, signSession, verifySession } from './authCrypto';
import {
  isValidLoginTicketId,
  PWA_LOGIN_TICKET_TTL_SEC,
} from './oauth';
import { SessionUser } from './types';
import { getUserRepository } from './users';

import { getEnvVar } from './env';

export const SESSION_COOKIE_NAME = 'tt_session';
const SESSION_TTL_SEC = 30 * 24 * 60 * 60; // 30 days

// The value this repository used to ship as a hardcoded fallback secret. It is
// public knowledge, so a deployment still using it must be treated as
// compromised and rotated, never silently accepted.
const LEAKED_DEFAULT_SESSION_SECRET = 'ticker-tracker-production-super-secret-key-32b';
const MIN_SESSION_SECRET_LENGTH = 32;

// Ephemeral fallback for development and tests only: generated once per
// process, never persisted, never valid in production.
let ephemeralDevSecret: string | null = null;

function randomSecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('');
}

export interface SessionCookieOptions {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax';
  path: string;
  maxAge: number;
  expires: Date;
}

export interface SessionCookie {
  name: string;
  value: string;
  options: SessionCookieOptions;
}

/** Cookie attributes for a 30-day session, shared by every issuing route. */
export function sessionCookieAttributes(secure: boolean): SessionCookieOptions {
  const now = Date.now();
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_SEC,
    expires: new Date(now + SESSION_TTL_SEC * 1000),
  };
}

/** Shape of the signed session token payload. */
export interface SessionPayload {
  user: SessionUser;
  exp?: number;
  /** Salt-derived marker of the password hash at signing time. */
  pwd?: string;
}

/**
 * Whether a session payload is still valid for the account's current password
 * hash. PBKDF2 re-salts on every password write, so a marker mismatch means
 * the token was issued before the last password change and must be rejected.
 *
 * Accounts without a password (Google-only) have nothing to rotate and always
 * pass; a malformed stored hash degrades to signature-plus-account-existence
 * validation rather than locking the user out.
 */
export function isPasswordMarkerValid(
  payload: SessionPayload | null,
  hashedPassword: string | undefined
): boolean {
  const expected = passwordMarker(hashedPassword);
  if (!expected) return true;
  return payload?.pwd === expected;
}

/**
 * Resolve the HMAC secret used to sign session cookies.
 *
 * Fail closed: a session token signed with a guessed or publicly known secret
 * grants access to any account, so the configured value must exist, be at
 * least 32 characters long, and never be the default that used to be
 * committed in this repository. In production a missing secret is a hard
 * error; outside production an unconfigured environment falls back to an
 * ephemeral per-process random secret so `next dev` keeps working.
 */
export function getSessionSecret(): string {
  const secret = getEnvVar('SESSION_SECRET');

  if (secret) {
    if (secret === LEAKED_DEFAULT_SESSION_SECRET) {
      throw new Error(
        'SESSION_SECRET is still set to the value that was committed in this repository. ' +
          'Rotate it now (wrangler secret put SESSION_SECRET / .env.local) before signing any session.'
      );
    }
    if (secret.length < MIN_SESSION_SECRET_LENGTH) {
      throw new Error(`SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters long`);
    }
    return secret;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'SESSION_SECRET is not configured. Refusing to sign sessions: a known or empty ' +
        'secret would let anyone forge a session cookie for any account.'
    );
  }

  // Development / tests without configuration: an ephemeral secret keeps local
  // work usable while guaranteeing no known value is ever signed with in
  // production. Sessions do not survive a process restart, which is
  // acceptable locally.
  ephemeralDevSecret ??= randomSecret();
  return ephemeralDevSecret;
}

/**
 * Build the session cookie value and attributes without writing it.
 *
 * Auth routes set this cookie directly on their outgoing response, which keeps
 * the `Set-Cookie` header on redirects (Google OAuth callback) instead of
 * relying on framework cookie merging that some browsers handle differently.
 *
 * `pwdMarker` embeds the current password-hash marker into the signed payload
 * (see `isPasswordMarkerValid`), so a password change invalidates every
 * session issued before it.
 */
export async function createSessionCookie(
  user: SessionUser,
  secure: boolean = process.env.NODE_ENV === 'production',
  pwdMarker?: string
): Promise<SessionCookie> {
  const now = Date.now();
  const value = await signSession(
    {
      user,
      pwd: pwdMarker,
      exp: now + SESSION_TTL_SEC * 1000,
    },
    getSessionSecret()
  );

  return {
    name: SESSION_COOKIE_NAME,
    value,
    options: sessionCookieAttributes(secure),
  };
}

/**
 * Server-signed `state` value for the standalone (home-screen app) login
 * flow. The initiating app and the Google callback run in different cookie
 * jars on iOS, so the state carries a reference to the KV login ticket
 * instead of relying on a cookie; the HMAC signature makes the reference
 * unforgeable and the expiry bounds its lifetime.
 */
export async function createLoginTicketState(ticketId: string): Promise<string> {
  return signSession(
    { t: ticketId, exp: Date.now() + PWA_LOGIN_TICKET_TTL_SEC * 1000 },
    getSessionSecret()
  );
}

/**
 * Resolve a `state` value back to its login ticket id, or null when the
 * value is not a ticket reference issued by this app (the browser flow uses
 * a plain random state string instead).
 */
export async function verifyLoginTicketState(state: string): Promise<string | null> {
  try {
    const payload = await verifySession<{ t?: unknown }>(state, getSessionSecret());
    if (typeof payload?.t !== 'string' || !isValidLoginTicketId(payload.t)) return null;
    return payload.t;
  } catch {
    return null;
  }
}

export async function getSessionUser(): Promise<SessionUser | null> {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
    if (!token) return null;

    const session = await verifySession<SessionPayload>(token, getSessionSecret());
    if (!session?.user?.id) return null;

    // A valid signature only proves the cookie was issued by this app; it does
    // not prove the account still exists. Without this lookup, a session would
    // survive account deletion or a storage migration until its 30-day expiry
    // (the "ghost session" case).
    const user = await getUserRepository().findById(session.user.id);
    if (!user) return null;

    // The marker check additionally proves the token was issued *after the
    // last password change*, so a stolen cookie dies the moment the user
    // rotates their password instead of surviving until the 30-day expiry.
    if (!isPasswordMarkerValid(session, user.hashedPassword)) return null;

    return session.user;
  } catch (err) {
    console.error('getSessionUser error:', err);
    return null;
  }
}

export async function setSessionUser(
  user: SessionUser,
  secure: boolean = process.env.NODE_ENV === 'production'
): Promise<void> {
  // Re-derive the password marker from the repository so the re-signed token
  // stays valid afterwards: the marker is part of the signed payload, and a
  // marker-less re-sign would invalidate the session on its next request.
  const record = await getUserRepository().findById(user.id);
  const cookie = await createSessionCookie(user, secure, passwordMarker(record?.hashedPassword));
  const cookieStore = await cookies();
  cookieStore.set(cookie.name, cookie.value, cookie.options);
}

export async function clearSession(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE_NAME);
}
