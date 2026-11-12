import { SessionUser } from './types';

export const CACHED_USER_STORAGE_KEY = 'tt_cached_user';

export type StorageReader = Pick<Storage, 'getItem'>;
export type StorageWriter = Pick<Storage, 'setItem' | 'removeItem'>;

/**
 * Parse and validate a serialized SessionUser payload from local storage.
 */
export function parseCachedUser(raw: string | null | undefined): SessionUser | null {
  if (!raw || typeof raw !== 'string') return null;

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.id !== 'string' ||
      !parsed.id.trim() ||
      typeof parsed.email !== 'string' ||
      !parsed.email.trim() ||
      typeof parsed.username !== 'string' ||
      !parsed.username.trim()
    ) {
      return null;
    }

    const user: SessionUser = {
      id: parsed.id,
      email: parsed.email,
      username: parsed.username,
    };

    if (typeof parsed.preferredCurrency === 'string' && parsed.preferredCurrency.trim()) {
      user.preferredCurrency = parsed.preferredCurrency.trim().toUpperCase();
    }

    return user;
  } catch {
    return null;
  }
}

/**
 * Read the cached authenticated user from localStorage, if available.
 */
export function getCachedUser(storage?: StorageReader | null): SessionUser | null {
  const target =
    storage !== undefined
      ? storage
      : typeof window !== 'undefined'
        ? window.localStorage
        : null;

  if (!target) return null;

  try {
    return parseCachedUser(target.getItem(CACHED_USER_STORAGE_KEY));
  } catch {
    return null;
  }
}

/**
 * Persist or clear the cached authenticated user in localStorage.
 */
export function saveCachedUser(
  user: SessionUser | null,
  storage?: StorageWriter | null
): void {
  const target =
    storage !== undefined
      ? storage
      : typeof window !== 'undefined'
        ? window.localStorage
        : null;

  if (!target) return;

  try {
    if (user) {
      target.setItem(CACHED_USER_STORAGE_KEY, JSON.stringify(user));
    } else {
      target.removeItem(CACHED_USER_STORAGE_KEY);
    }
  } catch {
    // Ignore storage quota or private-mode restrictions.
  }
}

export interface ReconcileSessionInput {
  /** Currently displayed (or locally cached) user session. */
  currentUser: SessionUser | null;
  /** HTTP status code from /api/auth/me, or null if the request failed to reach the server. */
  status: number | null;
  /** Parsed JSON body from /api/auth/me when available. */
  payload?: { user?: unknown } | null;
  /** True when fetch threw a network/offline error. */
  networkError?: boolean;
}

export interface ReconcileSessionResult {
  user: SessionUser | null;
  shouldPersist: boolean;
  shouldClear: boolean;
}

/**
 * Reconcile the locally cached user state with the background /api/auth/me response.
 *
 * - Network failures and transient 5xx responses preserve `currentUser` so offline
 *   or slow PWA startups never log the user out or flash the guest screen.
 * - Explicit 401/403 responses or a 200 `{ user: null }` payload confirm the
 *   session is no longer valid on the server and clear the cached user.
 * - A 200 response with a valid `SessionUser` updates and persists the cached user.
 */
export function reconcileSessionCheck({
  currentUser,
  status,
  payload,
  networkError = false,
}: ReconcileSessionInput): ReconcileSessionResult {
  if (networkError || status === null || status >= 500) {
    return {
      user: currentUser,
      shouldPersist: false,
      shouldClear: false,
    };
  }

  if (status === 401 || status === 403) {
    return {
      user: null,
      shouldPersist: false,
      shouldClear: true,
    };
  }

  if (status >= 200 && status < 300) {
    const serverUser =
      payload && typeof payload === 'object' && payload.user
        ? parseCachedUser(JSON.stringify(payload.user))
        : null;

    if (serverUser) {
      return {
        user: serverUser,
        shouldPersist: true,
        shouldClear: false,
      };
    }

    return {
      user: null,
      shouldPersist: false,
      shouldClear: true,
    };
  }

  return {
    user: currentUser,
    shouldPersist: false,
    shouldClear: false,
  };
}
