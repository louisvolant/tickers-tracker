import { NextResponse } from 'next/server';
import { getEnvVar } from '@/lib/env';

// Public origins that may front the app. The list is intentionally explicit:
// adding a new deployment origin should be a deliberate code change, not a
// side effect of whatever header a proxy happens to forward.
const PUBLIC_ORIGIN_ENV_VARS = [
  'NEXT_PUBLIC_APP_URL',
  'APP_URL',
  'NEXT_PUBLIC_SITE_URL',
  'SITE_URL',
] as const;

const DEV_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Extract a lowercase hostname from an absolute URL or a bare Host header. */
function parseHostname(value: string | null | undefined): string | null {
  if (!value) return null;

  // X-Forwarded-Host may contain a proxy chain: only the first entry is ours.
  const first = value.split(',')[0]?.trim();
  if (!first) return null;

  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(first) ? first : `http://${first}`;
  try {
    return new URL(candidate).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** The host and its apex/www counterpart, so both aliases are accepted. */
function withAliases(host: string): string[] {
  return host.startsWith('www.') ? [host, host.slice(4)] : [host, `www.${host}`];
}

function isDevHost(host: string): boolean {
  return DEV_HOSTNAMES.has(host) || host.endsWith('.local');
}

function allowedHosts(request: Request): Set<string> {
  const allowed = new Set<string>();

  const add = (host: string | null) => {
    if (!host) return;
    for (const alias of withAliases(host)) allowed.add(alias);
  };

  for (const name of PUBLIC_ORIGIN_ENV_VARS) {
    add(parseHostname(getEnvVar(name)));
  }

  add(parseHostname(request.headers.get('x-forwarded-host')));
  add(parseHostname(request.headers.get('host')));

  try {
    add(new URL(request.url).hostname.toLowerCase());
  } catch {
    // A malformed request URL leaves only the explicit headers above.
  }

  return allowed;
}

function forbidden(): NextResponse {
  return NextResponse.json(
    { error: 'invalid_origin' },
    { status: 403, headers: { 'Cache-Control': 'private, no-store' } }
  );
}

/**
 * CSRF guard for custom mutation routes.
 *
 * Returns null when the request may proceed and a 403 JSON response otherwise.
 * Requests without Origin/Referer are allowed: curl and same-origin clients
 * often omit them, and a missing header is not a cross-site forgery signal.
 * The framework auth routes and signed webhooks do not use this helper.
 */
export function assertSameOrigin(request: Request): NextResponse | null {
  const origin = request.headers.get('origin')?.trim();
  const referer = request.headers.get('referer')?.trim();
  const raw = origin || referer;

  // Neither header: nothing to compare, so let the request through.
  if (!raw) return null;

  // Browsers send this for opaque/sandboxed origins; it can never be trusted.
  if (raw === 'null') return forbidden();

  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return forbidden();
  }

  if (!host) return forbidden();
  if (isDevHost(host)) return null;
  if (allowedHosts(request).has(host)) return null;

  return forbidden();
}
