// One-time OAuth transaction state: the CSRF `state` plus the RFC 7636 PKCE
// code verifier, stored in a short-lived cookie that only the callback route
// can read.
//
// Google OAuth without a `state` parameter accepts any authorization response
// the browser can be made to carry ("login CSRF": an attacker completes a
// login with their own Google account in the victim's browser, so the victim
// silently works inside the attacker's account). PKCE additionally binds the
// authorization code to this browser instance, so a code leaked through a
// redirect URL, a referrer header or browser history cannot be exchanged by
// anyone else.

export const OAUTH_TXN_COOKIE = 'tt_oauth_txn';

/** The transaction must survive the round trip to Google and nothing more. */
export const OAUTH_TXN_MAX_AGE_SEC = 10 * 60;

/** Restrict the cookie to the only route that legitimately reads it. */
export const OAUTH_TXN_COOKIE_PATH = '/api/auth/callback/google';

export interface OAuthTransaction {
  /** Unguessable value echoed back by Google; binds the callback to this flow. */
  state: string;
  /** PKCE code_verifier, sent only in the token exchange. */
  codeVerifier: string;
  /** base64url(SHA-256(codeVerifier)), sent in the authorization request. */
  codeChallenge: string;
  /** Opaque cookie value carrying the state and the verifier. */
  cookieValue: string;
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function randomToken(bytes: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function createOAuthTransaction(): Promise<OAuthTransaction> {
  const state = randomToken(32);
  // RFC 7636 requires 43-128 characters of unreserved characters; 32 random
  // bytes in base64url is exactly 43.
  const codeVerifier = randomToken(32);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
  const codeChallenge = base64Url(new Uint8Array(digest));
  const cookieValue = base64Url(new TextEncoder().encode(JSON.stringify({ state, codeVerifier })));

  return { state, codeVerifier, codeChallenge, cookieValue };
}

export interface ParsedOAuthTransaction {
  state: string;
  codeVerifier: string;
}

/** Decode and validate the transaction cookie; any tampering yields null. */
export function parseOAuthTransaction(raw: string | null | undefined): ParsedOAuthTransaction | null {
  if (!raw || typeof raw !== 'string' || raw.length > 512) return null;

  let parsed: { state?: unknown; codeVerifier?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (typeof parsed.state !== 'string' || parsed.state.length === 0) return null;
  if (typeof parsed.codeVerifier !== 'string') return null;
  if (parsed.codeVerifier.length < 43 || parsed.codeVerifier.length > 128) return null;

  return { state: parsed.state, codeVerifier: parsed.codeVerifier };
}
