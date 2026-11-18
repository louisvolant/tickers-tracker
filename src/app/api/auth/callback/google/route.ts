import { NextRequest, NextResponse } from 'next/server';
import { passwordMarker } from '@/lib/authCrypto';
import { createSessionCookie, verifyLoginTicketState } from '@/lib/session';
import {
  completeLoginTicket,
  getLoginTicket,
  OAUTH_TXN_COOKIE,
  OAUTH_TXN_COOKIE_PATH,
  parseOAuthTransaction,
} from '@/lib/oauth';
import { UserRecord } from '@/lib/types';
import { getUserRepository } from '@/lib/users';

import { getEnvVar, getRequestOrigin } from '@/lib/env';

export const runtime = 'nodejs';

/**
 * Redirect responses must never be cached: the successful callback carries
 * session material, and a shared cache replaying it would hand the same
 * session to another visitor. 303 is also the correct status after an OAuth
 * callback, so browsers follow it with a plain GET.
 */
function redirectTo(url: string): NextResponse {
  const response = NextResponse.redirect(url, 303);
  response.headers.set('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
  return response;
}

/**
 * Redirect and consume the one-time OAuth transaction cookie in the same
 * response, so a state/verifier pair can never be replayed.
 */
function redirectToAndClearTxn(url: string, secure: boolean): NextResponse {
  const response = redirectTo(url);
  response.cookies.set(OAUTH_TXN_COOKIE, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: OAUTH_TXN_COOKIE_PATH,
    maxAge: 0,
  });
  return response;
}

interface GoogleProfile {
  id: string;
  email: string;
  name?: string;
}

type GoogleResolution =
  | { ok: false; reason: 'token_exchange_failed' | 'userinfo_failed' }
  | { ok: true; profile: GoogleProfile };

/** Exchange the one-time authorization code with the PKCE verifier. */
async function resolveGoogleCode(params: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
}): Promise<GoogleResolution> {
  // PKCE: the verifier proves this flow was started by the party that holds
  // it; a code intercepted elsewhere exchanges to nothing without it.
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code: params.code,
      client_id: params.clientId,
      client_secret: params.clientSecret,
      redirect_uri: params.redirectUri,
      code_verifier: params.codeVerifier,
      grant_type: 'authorization_code',
    }),
  });

  if (!tokenRes.ok) {
    console.error('Google token exchange error:', await tokenRes.text());
    return { ok: false, reason: 'token_exchange_failed' };
  }

  const { access_token } = (await tokenRes.json()) as { access_token: string };

  const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${access_token}` },
  });

  if (!userRes.ok) {
    return { ok: false, reason: 'userinfo_failed' };
  }

  const profile = (await userRes.json()) as GoogleProfile;
  if (!profile?.id || !profile?.email) {
    return { ok: false, reason: 'userinfo_failed' };
  }

  return { ok: true, profile };
}

/** Find or create the account, then record the sign-in (best-effort). */
async function linkGoogleProfile(profile: GoogleProfile): Promise<UserRecord> {
  const cleanEmail = profile.email.toLowerCase().trim();
  const repo = getUserRepository();
  const user = await repo.linkGoogleAccount(
    cleanEmail,
    profile.id,
    profile.name || cleanEmail.split('@')[0]
  );

  try {
    await repo.updateLastLogin(user.id, Date.now());
  } catch (err) {
    console.warn('Could not update last_login_at:', err);
  }

  return user;
}

export async function GET(request: NextRequest) {
  // Deliberately no assertSameOrigin(): this is the provider's cross-site
  // redirect back from Google, not a browser-initiated mutation. The one-time
  // OAuth code and the state binding below authorize the callback.
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const origin = getRequestOrigin(request);
  const redirectUri = `${origin}/api/auth/callback/google`;
  const secure = origin.startsWith('https://');

  if (!code || !state) {
    return redirectToAndClearTxn(`${origin}?auth_error=missing_code`, secure);
  }

  const clientId = getEnvVar('GOOGLE_CLIENT_ID');
  const clientSecret = getEnvVar('GOOGLE_CLIENT_SECRET');

  if (!clientId || !clientSecret) {
    return redirectToAndClearTxn(`${origin}?auth_error=google_credentials_missing`, secure);
  }

  const exchange = { clientId, clientSecret, redirectUri, code };

  try {
    // Flow 1 — browser: the state must match the one-time transaction cookie
    // issued by /api/auth/google. This rejects login CSRF (an attacker
    // completing their own OAuth login in the victim's browser) and any
    // callback that was not started by this browser.
    const txn = parseOAuthTransaction(request.cookies.get(OAUTH_TXN_COOKIE)?.value);
    if (txn && state === txn.state) {
      const resolved = await resolveGoogleCode({ ...exchange, codeVerifier: txn.codeVerifier });
      if (!resolved.ok) {
        return redirectToAndClearTxn(`${origin}?auth_error=${resolved.reason}`, secure);
      }

      const user = await linkGoogleProfile(resolved.profile);
      const sessionUser = {
        id: user.id,
        email: user.email,
        username: user.username,
        preferredCurrency: user.preferredCurrency,
      };

      const session = await createSessionCookie(
        sessionUser,
        secure,
        passwordMarker(user.hashedPassword)
      );

      const response = redirectToAndClearTxn(`${origin}?auth_success=true`, secure);
      response.cookies.set(session.name, session.value, session.options);
      return response;
    }

    // Flow 2 — standalone (home-screen app) handoff: iOS runs the standalone
    // webview and Safari in separate cookie jars, so the state is a
    // server-signed ticket reference instead of a cookie. The ticket must
    // still be pending and unexpired; completing it stores the pre-signed
    // session for the initiating app to redeem through the login-status poll.
    const ticketId = await verifyLoginTicketState(state);
    if (ticketId) {
      const ticket = await getLoginTicket(ticketId);
      if (!ticket?.codeVerifier || Date.now() > ticket.expiresAt) {
        return redirectToAndClearTxn(`${origin}?auth_error=invalid_state`, secure);
      }

      const resolved = await resolveGoogleCode({ ...exchange, codeVerifier: ticket.codeVerifier });
      if (!resolved.ok) {
        return redirectToAndClearTxn(`${origin}?auth_error=${resolved.reason}`, secure);
      }

      const user = await linkGoogleProfile(resolved.profile);
      const sessionUser = {
        id: user.id,
        email: user.email,
        username: user.username,
        preferredCurrency: user.preferredCurrency,
      };

      const session = await createSessionCookie(
        sessionUser,
        secure,
        passwordMarker(user.hashedPassword)
      );

      // Hand the pre-signed session to the initiating app through the
      // ticket. Do NOT set a cookie here: this window (Safari) is not the
      // app that started the flow, and writing a session into it would be a
      // login-CSRF vector. The app redeems the ticket through
      // GET /api/auth/login-status, which sets the cookie in its own jar.
      await completeLoginTicket(ticketId, session.value, sessionUser);
      return redirectTo(`${origin}/?pwa_login=complete`);
    }

    return redirectToAndClearTxn(`${origin}?auth_error=invalid_state`, secure);
  } catch (err) {
    console.error('Google auth callback error:', err);
    return redirectToAndClearTxn(`${origin}?auth_error=oauth_internal_error`, secure);
  }
}
