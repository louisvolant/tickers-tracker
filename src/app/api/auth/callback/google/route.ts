import { NextRequest, NextResponse } from 'next/server';
import { createSessionCookie } from '@/lib/session';
import { getUserRepository } from '@/lib/users';

import { getEnvVar, getRequestOrigin } from '@/lib/env';
import { OAUTH_TXN_COOKIE, OAUTH_TXN_COOKIE_PATH, parseOAuthTransaction } from '@/lib/oauth';

export const runtime = 'nodejs';

/**
 * Redirect responses must never be cached: the successful callback carries the
 * session `Set-Cookie` header, and a shared cache replaying it would hand the
 * same session to another visitor. 303 is also the correct status after an
 * OAuth callback, so browsers follow it with a plain GET.
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

export async function GET(request: NextRequest) {
  // Deliberately no assertSameOrigin(): this is the provider's cross-site
  // redirect back from Google, not a browser-initiated mutation. The one-time
  // OAuth code and the state cookie below authorize the callback.
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const origin = getRequestOrigin(request);
  const redirectUri = `${origin}/api/auth/callback/google`;
  const secure = origin.startsWith('https://');

  // The transaction (state + PKCE verifier) was issued by /api/auth/google
  // and stored in a cookie scoped to this route. The echoed `state` must
  // match: this rejects login CSRF (an attacker completing their own OAuth
  // login in the victim's browser) and any callback that was not started by
  // this browser.
  const txn = parseOAuthTransaction(request.cookies.get(OAUTH_TXN_COOKIE)?.value);
  if (!txn || !state || state !== txn.state) {
    return redirectToAndClearTxn(`${origin}?auth_error=invalid_state`, secure);
  }

  if (!code) {
    return redirectToAndClearTxn(`${origin}?auth_error=missing_code`, secure);
  }

  const clientId = getEnvVar('GOOGLE_CLIENT_ID');
  const clientSecret = getEnvVar('GOOGLE_CLIENT_SECRET');

  if (!clientId || !clientSecret) {
    return redirectToAndClearTxn(`${origin}?auth_error=google_credentials_missing`, secure);
  }

  try {
    // 1. Exchange code for access token. The PKCE verifier proves this
    // browser started the flow: a code intercepted elsewhere exchanges to
    // nothing without it.
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code_verifier: txn.codeVerifier,
        grant_type: 'authorization_code',
      }),
    });

    if (!tokenRes.ok) {
      console.error('Google token exchange error:', await tokenRes.text());
      return redirectToAndClearTxn(`${origin}?auth_error=token_exchange_failed`, secure);
    }

    const { access_token } = (await tokenRes.json()) as { access_token: string };

    // 2. Fetch user profile
    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${access_token}` },
    });

    if (!userRes.ok) {
      return redirectToAndClearTxn(`${origin}?auth_error=userinfo_failed`, secure);
    }

    const profile = (await userRes.json()) as { id: string; email: string; name?: string };
    const cleanEmail = profile.email.toLowerCase().trim();

    // 3. Find or create the account. The unique email index makes this safe
    // under concurrent callbacks; the dual backend mirrors the result to KV.
    const repo = getUserRepository();
    const user = await repo.linkGoogleAccount(
      cleanEmail,
      profile.id,
      profile.name || cleanEmail.split('@')[0]
    );

    // 4. Record the sign-in. Best-effort so a database that has not applied
    // migration 0003 still completes the OAuth flow.
    try {
      await repo.updateLastLogin(user.id, Date.now());
    } catch (err) {
      console.warn('Could not update last_login_at:', err);
    }

    // 5. Build the session cookie and attach it to the redirect itself.
    const session = await createSessionCookie(
      {
        id: user.id,
        email: user.email,
        username: user.username,
        preferredCurrency: user.preferredCurrency,
      },
      secure
    );

    const response = redirectToAndClearTxn(`${origin}?auth_success=true`, secure);
    response.cookies.set(session.name, session.value, session.options);
    return response;
  } catch (err) {
    console.error('Google auth callback error:', err);
    return redirectToAndClearTxn(`${origin}?auth_error=oauth_internal_error`, secure);
  }
}
