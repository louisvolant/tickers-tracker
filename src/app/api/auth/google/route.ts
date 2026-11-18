import { NextRequest, NextResponse } from 'next/server';

import { getEnvVar, getRequestOrigin } from '@/lib/env';
import { createLoginTicketState } from '@/lib/session';
import {
  createLoginTicket,
  createOAuthTransaction,
  isValidLoginTicketId,
  OAUTH_TXN_COOKIE,
  OAUTH_TXN_COOKIE_PATH,
  OAUTH_TXN_MAX_AGE_SEC,
} from '@/lib/oauth';

export const runtime = 'nodejs';

function buildGoogleAuthUrl(
  clientId: string,
  redirectUri: string,
  state: string,
  codeChallenge: string
): string {
  const scope = encodeURIComponent('openid email profile');
  return (
    `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code&scope=${scope}&access_type=offline&prompt=select_account` +
    `&state=${encodeURIComponent(state)}` +
    `&code_challenge=${encodeURIComponent(codeChallenge)}` +
    `&code_challenge_method=S256`
  );
}

export async function GET(request: NextRequest) {
  const clientId = getEnvVar('GOOGLE_CLIENT_ID');
  const origin = getRequestOrigin(request);
  const redirectUri = `${origin}/api/auth/callback/google`;

  if (!clientId) {
    return NextResponse.redirect(`${origin}?auth_error=google_oauth_not_configured`);
  }

  const { searchParams } = new URL(request.url);
  const ticketId = searchParams.get('nonce');

  // Standalone (home-screen app) flow: iOS hands the Google navigation to
  // Safari and isolates the app's cookie jar from it, so the state cannot
  // travel in a cookie. It is a server-signed reference to a KV login ticket
  // that holds the PKCE verifier, and the client polls for the completed
  // handoff by its unguessable nonce.
  if (searchParams.get('pwa') === '1' && isValidLoginTicketId(ticketId)) {
    const ticket = await createLoginTicket(ticketId);
    const state = await createLoginTicketState(ticketId);
    return NextResponse.redirect(buildGoogleAuthUrl(clientId, redirectUri, state, ticket.codeChallenge));
  }

  // Browser flow: CSRF `state` plus the PKCE verifier, bound to this browser
  // by a short-lived HttpOnly cookie that only the callback route can read.
  const txn = await createOAuthTransaction();

  const response = NextResponse.redirect(buildGoogleAuthUrl(clientId, redirectUri, txn.state, txn.codeChallenge));
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
