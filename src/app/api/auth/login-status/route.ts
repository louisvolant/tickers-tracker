import { NextRequest, NextResponse } from 'next/server';
import { isValidLoginTicketId, getLoginTicket, redeemLoginTicket } from '@/lib/oauth';
import { SESSION_COOKIE_NAME, sessionCookieAttributes } from '@/lib/session';
import { getRequestOrigin } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function noStore(body: object): NextResponse {
  return NextResponse.json(body, {
    headers: { 'Cache-Control': 'private, no-store, max-age=0, must-revalidate' },
  });
}

/**
 * GET /api/auth/login-status?ticket=<nonce>
 *
 * Poll endpoint of the standalone (home-screen app) Google login relay.
 * While the user is still on Google's page the ticket is pending; once the
 * callback completed it, this response redeems it exactly once: the
 * pre-signed session cookie is set in the cookie jar of the app making this
 * same-origin request, and the ticket is deleted.
 *
 * The nonce is unguessable (32 random bytes), so possession of it is the
 * authorization; no cookie is required to poll.
 */
export async function GET(request: NextRequest) {
  const ticketId = request.nextUrl.searchParams.get('ticket');
  if (!isValidLoginTicketId(ticketId)) {
    return noStore({ status: 'invalid' });
  }

  try {
    const completed = await redeemLoginTicket(ticketId);
    if (completed?.sessionValue && completed.user) {
      const secure = getRequestOrigin(request).startsWith('https://');
      const response = noStore({ status: 'ok', user: completed.user });
      response.cookies.set(
        SESSION_COOKIE_NAME,
        completed.sessionValue,
        sessionCookieAttributes(secure)
      );
      return response;
    }

    // Not completed yet (or already redeemed). Distinguish pending from
    // expired so the client knows whether to keep polling.
    const existing = await getLoginTicket(ticketId);
    return noStore({ status: existing ? 'pending' : 'expired' });
  } catch (err) {
    console.error('Login status poll failed:', err);
    return noStore({ status: 'expired' });
  }
}
