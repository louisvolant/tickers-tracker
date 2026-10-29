import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/session';
import {
  addPushSubscription,
  getPushSubscriptions,
  getVapidKeys,
  isAcceptablePushEndpoint,
  parsePushSubscription,
  removePushSubscription,
} from '@/lib/push';
import { assertSameOrigin } from '@/lib/sameOrigin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/push/subscribe
 *
 * Returns the VAPID public key to the client (it is public by design) and the
 * number of devices currently subscribed, so the UI can show the push state
 * without duplicating the browser's own permission state.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const vapid = getVapidKeys();
    const subscriptions = await getPushSubscriptions(user.id);

    return NextResponse.json(
      { publicKey: vapid?.publicKey ?? null, count: subscriptions.length },
      { headers: { 'Cache-Control': 'private, no-store' } }
    );
  } catch (err) {
    console.error('Error reading push subscriptions:', err);
    return NextResponse.json({ error: 'Failed to read subscriptions' }, { status: 500 });
  }
}

/**
 * POST /api/push/subscribe
 *
 * Persists the browser PushSubscription returned by `pushManager.subscribe()`.
 * Idempotent: subscribing the same endpoint again refreshes it in place.
 */
export async function POST(request: NextRequest) {
  const originError = assertSameOrigin(request);
  if (originError) return originError;

  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!getVapidKeys()) {
    return NextResponse.json({ error: 'Web push is not configured' }, { status: 503 });
  }

  try {
    const body = await request.json().catch(() => null);
    const subscription = parsePushSubscription(body?.subscription);

    if (!subscription) {
      return NextResponse.json({ error: 'Invalid push subscription' }, { status: 400 });
    }

    const count = await addPushSubscription(
      user.id,
      subscription,
      request.headers.get('user-agent') || undefined
    );

    return NextResponse.json({ count }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    console.error('Error saving push subscription:', err);
    return NextResponse.json({ error: 'Failed to save subscription' }, { status: 500 });
  }
}

/**
 * DELETE /api/push/subscribe?endpoint=...
 *
 * Removes one device. Used when the user disables notifications, and by the
 * account deletion flow (which drops the whole key).
 */
export async function DELETE(request: NextRequest) {
  const originError = assertSameOrigin(request);
  if (originError) return originError;

  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const fromQuery = request.nextUrl.searchParams.get('endpoint');
    const body = fromQuery ? null : await request.json().catch(() => null);
    const endpoint = fromQuery || body?.endpoint;

    if (!isAcceptablePushEndpoint(endpoint)) {
      return NextResponse.json({ error: 'Invalid push endpoint' }, { status: 400 });
    }

    const removed = await removePushSubscription(user.id, endpoint);
    return NextResponse.json({ removed }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    console.error('Error removing push subscription:', err);
    return NextResponse.json({ error: 'Failed to remove subscription' }, { status: 500 });
  }
}
