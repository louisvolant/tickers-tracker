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

import { kvDelete, kvGet, kvPut } from './kv';
import type { SessionUser } from './types';

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

// ---------------------------------------------------------------------------
// Standalone (home-screen app) login handoff tickets.
//
// iOS runs home-screen web apps in a sandboxed web view that shares neither
// cookies nor storage with Safari, and it hands external navigations
// (accounts.google.com) to Safari. The OAuth state therefore cannot travel in
// a cookie for this flow: the callback runs in Safari's cookie jar, the
// initiating app in its own. Instead, the client generates an unguessable
// ticket id, the authorization request carries a server-signed reference to a
// KV ticket (which holds the PKCE verifier), and the callback stores the
// pre-signed session against the ticket. The app redeems it through a
// same-origin poll, which sets the session cookie in the app's own jar.
// ---------------------------------------------------------------------------

/** A ticket is only useful while Google login can still complete within it. */
export const PWA_LOGIN_TICKET_TTL_SEC = 10 * 60;

const LOGIN_TICKET_PREFIX = 'oauth:ticket:';
/** Client-generated nonce: 32 random bytes in base64url (43 characters). */
const TICKET_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface LoginTicket {
  /** PKCE verifier for the in-flight authorization; absent once completed. */
  codeVerifier?: string;
  createdAt: number;
  expiresAt: number;
  /** Pre-signed session cookie handed back to the initiating app once completed. */
  sessionValue?: string;
  user?: SessionUser;
}

function loginTicketKey(ticketId: string): string {
  return `${LOGIN_TICKET_PREFIX}${ticketId}`;
}

export function isValidLoginTicketId(id: string | null | undefined): id is string {
  return typeof id === 'string' && TICKET_ID_PATTERN.test(id);
}

/** Create (or restart) the one-time login ticket for a client-generated nonce. */
export async function createLoginTicket(
  ticketId: string
): Promise<{ codeVerifier: string; codeChallenge: string }> {
  const codeVerifier = randomToken(32);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
  const codeChallenge = base64Url(new Uint8Array(digest));
  const now = Date.now();

  await kvPut(
    loginTicketKey(ticketId),
    {
      codeVerifier,
      createdAt: now,
      expiresAt: now + PWA_LOGIN_TICKET_TTL_SEC * 1000,
    },
    { expirationTtl: PWA_LOGIN_TICKET_TTL_SEC }
  );

  return { codeVerifier, codeChallenge };
}

export async function getLoginTicket(ticketId: string): Promise<LoginTicket | null> {
  return kvGet<LoginTicket>(loginTicketKey(ticketId));
}

/**
 * Replace the pending ticket with the completed handoff payload: the
 * pre-signed session cookie value and the user it authenticates.
 */
export async function completeLoginTicket(
  ticketId: string,
  sessionValue: string,
  user: SessionUser
): Promise<void> {
  const existing = await getLoginTicket(ticketId);
  await kvPut(
    loginTicketKey(ticketId),
    {
      createdAt: existing?.createdAt ?? Date.now(),
      expiresAt: Date.now() + PWA_LOGIN_TICKET_TTL_SEC * 1000,
      sessionValue,
      user,
    },
    { expirationTtl: PWA_LOGIN_TICKET_TTL_SEC }
  );
}

/**
 * One-time redemption of a completed ticket: returns the handoff payload and
 * deletes the ticket. A pending (not yet completed) ticket survives, because
 * the initiating app polls while the user is still on Google's page.
 */
export async function redeemLoginTicket(ticketId: string): Promise<LoginTicket | null> {
  const ticket = await getLoginTicket(ticketId);
  if (!ticket?.sessionValue || !ticket.user) return null;
  await kvDelete(loginTicketKey(ticketId));
  return ticket;
}
