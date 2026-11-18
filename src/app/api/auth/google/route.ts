import { NextRequest, NextResponse } from 'next/server';

import { getEnvVar, getRequestOrigin } from '@/lib/env';
import {
  createOAuthTransaction,
  OAUTH_TXN_COOKIE,
  OAUTH_TXN_COOKIE_PATH,
  OAUTH_TXN_MAX_AGE_SEC,
} from '@/lib/oauth';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const clientId = getEnvVar('GOOGLE_CLIENT_ID');
  const origin = getRequestOrigin(request);
  const redirectUri = `${origin}/api/auth/callback/google`;

  if (!clientId) {
    return NextResponse.redirect(`${origin}?auth_error=google_oauth_not_configured`);
  }

  // CSRF `state` plus the PKCE verifier, bound to this browser by a
  // short-lived HttpOnly cookie that only the callback route can read.
  const txn = await createOAuthTransaction();

  const scope = encodeURIComponent('openid email profile');
  const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(
    redirectUri
  )}&response_type=code&scope=${scope}&access_type=offline&prompt=select_account&state=${encodeURIComponent(
    txn.state
  )}&code_challenge=${encodeURIComponent(txn.codeChallenge)}&code_challenge_method=S256`;

  const response = NextResponse.redirect(googleAuthUrl);
  response.cookies.set(OAUTH_TXN_COOKIE, txn.cookieValue, {
    httpOnly: true,
    // SameSite=Lax is sufficient: Google's redirect back is a top-level GET
    // navigation, which Lax cookies accompany.
    sameSite: 'lax',
    secure: origin.startsWith('https://'),
    path: OAUTH_TXN_COOKIE_PATH,
    maxAge: OAUTH_TXN_MAX_AGE_SEC,
  });
  return response;
}
