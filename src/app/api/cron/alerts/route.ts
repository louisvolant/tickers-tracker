import { NextRequest, NextResponse } from 'next/server';
import { getEnvVar } from '@/lib/env';
import { verifyCronRequest } from '@/lib/cronAuth';
import { runAlertScan } from '@/lib/alertScan';
import { dispatchAlertNotifications } from '@/lib/alertDispatch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handle(request: NextRequest) {
  // Deliberately no assertSameOrigin(): this is a signed machine-to-machine
  // webhook. verifyCronRequest() below authenticates the timestamped HMAC, which
  // is the correct control for a caller that has no browser origin.
  const secret = getEnvVar('CRON_SECRET');
  if (!secret) {
    // Fail closed: an unauthenticated scan endpoint would let anyone burn the
    // Yahoo rate limit and the KV write quota.
    return NextResponse.json({ error: 'CRON_SECRET is not configured' }, { status: 503 });
  }

  // Timestamped HMAC over `${timestamp}.${method}.${path}`. A static Bearer
  // would be replayable forever if it ever leaked; this expires after 5 minutes.
  const verification = await verifyCronRequest(
    secret,
    request.headers,
    request.method,
    request.nextUrl.pathname
  );

  if (!verification.ok) {
    // Log the reason but return a generic 401, so the response does not tell an
    // attacker which check failed.
    console.warn(`Rejected cron request: ${verification.reason}`);
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // The scan owns its own lock, written only once it knows there is at least
    // one open venue to evaluate. See runAlertScan().
    const result = await runAlertScan();

    if (result.skipped) {
      return NextResponse.json({ skipped: 'scan-already-running' });
    }

    const delivery = await dispatchAlertNotifications(result.triggered);

    // Counts only: the endpoint is secret-gated, but symbol lists and user ids
    // do not belong in a response or in the logs.
    return NextResponse.json(
      {
        scannedTickers: result.scannedTickers,
        fetchedQuotes: result.fetchedQuotes,
        triggered: result.triggered.length,
        pushed: delivery.pushed,
        prunedSubscriptions: delivery.prunedSubscriptions,
        stateWrites: result.stateWrites,
        quoteWrites: result.quoteWrites,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    console.error('Alert scan failed:', err);
    return NextResponse.json({ error: 'Alert scan failed' }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
