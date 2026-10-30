import { NextRequest, NextResponse } from 'next/server';
import { createSessionCookie } from '@/lib/session';
import { getUserRepository } from '@/lib/users';

import { getEnvVar, getRequestOrigin } from '@/lib/env';

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

export async function GET(request: NextRequest) {
  // Deliberately no assertSameOrigin(): this is the provider's cross-site
  // redirect back from Google, not a browser-initiated mutation. The one-time
  // OAuth code exchanged below is the credential that authorizes the callback.
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const origin = getRequestOrigin(request);
  const redirectUri = `${origin}/api/auth/callback/google`;

  if (!code) {
    return redirectTo(`${origin}?auth_error=missing_code`);
  }

  const clientId = getEnvVar('GOOGLE_CLIENT_ID');
  const clientSecret = getEnvVar('GOOGLE_CLIENT_SECRET');

  if (!clientId || !clientSecret) {
    return redirectTo(`${origin}?auth_error=google_credentials_missing`);
  }

  try {
    // 1. Exchange code for access token
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });

    if (!tokenRes.ok) {
      console.error('Google token exchange error:', await tokenRes.text());
      return redirectTo(`${origin}?auth_error=token_exchange_failed`);
    }

    const { access_token } = (await tokenRes.json()) as { access_token: string };

    // 2. Fetch user profile
    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${access_token}` },
    });

    if (!userRes.ok) {
      return redirectTo(`${origin}?auth_error=userinfo_failed`);
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
      origin.startsWith('https://')
    );

    const response = redirectTo(`${origin}?auth_success=true`);
    response.cookies.set(session.name, session.value, session.options);
    return response;
  } catch (err) {
    console.error('Google auth callback error:', err);
    return redirectTo(`${origin}?auth_error=oauth_internal_error`);
  }
}
