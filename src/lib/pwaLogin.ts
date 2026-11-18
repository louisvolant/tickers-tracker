// Client-side helpers for the standalone (home-screen app) Google login.
//
// iOS runs home-screen web apps in a sandboxed web view that shares neither
// cookies nor storage with Safari, and it hands external navigations
// (accounts.google.com) to Safari. An OAuth redirect flow started by the app
// therefore returns its session cookie to Safari, never to the app. The relay
// instead:
//
//   1. the app generates an unguessable nonce and navigates to
//      /api/auth/google?pwa=1&nonce=..., which stores a login ticket (PKCE
//      verifier) server-side and signs the nonce into the OAuth state;
//   2. Safari completes the Google login; the callback stores the pre-signed
//      session against the ticket instead of setting a cookie;
//   3. the app polls /api/auth/login-status?ticket=..., which sets the
//      session cookie in the app's own cookie jar and returns the user.

export const STANDALONE_LOGIN_STORAGE_KEY = 'tt_standalone_login_ticket';

/** Must mirror PWA_LOGIN_TICKET_TTL_SEC on the server. */
const TICKET_FRESHNESS_MS = 10 * 60 * 1000;

export interface StandaloneLoginTicket {
  nonce: string;
  createdAt: number;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function resolveStorage(storage?: StorageLike | null): StorageLike | null {
  if (storage !== undefined) return storage;
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** True when running inside an installed home-screen / standalone web app. */
export function isStandaloneApp(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true || nav.standalone === true
  );
}

function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Start the Google login from a standalone app: persist the nonce so the
 * poll can resume even if iOS suspends or kills the app during the Safari
 * round trip, then navigate.
 */
export function beginStandaloneGoogleLogin(): void {
  const nonce = randomNonce();
  savePendingStandaloneLogin({ nonce, createdAt: Date.now() });
  window.location.assign(`/api/auth/google?pwa=1&nonce=${encodeURIComponent(nonce)}`);
}

/** Persist a pending ticket, best-effort (private mode may refuse writes). */
export function savePendingStandaloneLogin(
  ticket: StandaloneLoginTicket,
  storage?: StorageLike | null
): void {
  const target = resolveStorage(storage);
  if (!target) return;
  try {
    target.setItem(STANDALONE_LOGIN_STORAGE_KEY, JSON.stringify(ticket));
  } catch {
    // Storage quota or private-mode restrictions: the poll still works for
    // this session, it just cannot survive an app kill.
  }
}

/**
 * The pending ticket, or null when none exists or it is older than the
 * server-side TTL (stale entries are removed).
 */
export function readPendingStandaloneLogin(storage?: StorageLike | null): StandaloneLoginTicket | null {
  const target = resolveStorage(storage);
  if (!target) return null;

  let raw: string | null = null;
  try {
    raw = target.getItem(STANDALONE_LOGIN_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as { nonce?: unknown; createdAt?: unknown };
    if (typeof parsed.nonce !== 'string' || typeof parsed.createdAt !== 'number') {
      clearStandaloneLogin(target);
      return null;
    }
    if (Date.now() - parsed.createdAt > TICKET_FRESHNESS_MS) {
      clearStandaloneLogin(target);
      return null;
    }
    return { nonce: parsed.nonce, createdAt: parsed.createdAt };
  } catch {
    clearStandaloneLogin(target);
    return null;
  }
}

/** Clear the pending ticket after a completed or abandoned login. */
export function clearStandaloneLogin(storage?: StorageLike | null): void {
  const target = resolveStorage(storage);
  if (!target) return;
  try {
    target.removeItem(STANDALONE_LOGIN_STORAGE_KEY);
  } catch {
    // Ignore private-mode restrictions.
  }
}
