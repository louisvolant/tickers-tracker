import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  CACHED_USER_STORAGE_KEY,
  getCachedUser,
  parseCachedUser,
  reconcileSessionCheck,
  saveCachedUser,
} from '../src/lib/authSession';
import { SessionUser } from '../src/lib/types';

function createMemoryStorage(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
    removeItem(key: string) {
      store.delete(key);
    },
    dump() {
      return Object.fromEntries(store.entries());
    },
  };
}

const SAMPLE_USER: SessionUser = {
  id: 'usr_123',
  email: 'investor@example.com',
  username: 'investor',
  preferredCurrency: 'EUR',
};

describe('Cached session user storage', () => {
  test('round-trips a valid SessionUser through storage', () => {
    const storage = createMemoryStorage();
    saveCachedUser(SAMPLE_USER, storage);

    const restored = getCachedUser(storage);
    assert.deepEqual(restored, SAMPLE_USER);
  });

  test('removes the storage key when saving null on logout', () => {
    const storage = createMemoryStorage({
      [CACHED_USER_STORAGE_KEY]: JSON.stringify(SAMPLE_USER),
    });

    saveCachedUser(null, storage);
    assert.equal(getCachedUser(storage), null);
    assert.equal(storage.getItem(CACHED_USER_STORAGE_KEY), null);
  });

  test('rejects malformed or incomplete JSON payloads', () => {
    assert.equal(parseCachedUser(null), null);
    assert.equal(parseCachedUser(''), null);
    assert.equal(parseCachedUser('{not-json'), null);
    assert.equal(parseCachedUser(JSON.stringify({ id: 'usr_1', email: 'a@b.c' })), null);
    assert.equal(
      parseCachedUser(JSON.stringify({ id: '', email: 'a@b.c', username: 'u' })),
      null
    );
  });

  test('tolerates throwing storage implementations (e.g. private browsing)', () => {
    const brokenStorage = {
      getItem(): string | null {
        throw new Error('QuotaExceededError');
      },
      setItem(): void {
        throw new Error('QuotaExceededError');
      },
      removeItem(): void {
        throw new Error('QuotaExceededError');
      },
    };

    assert.doesNotThrow(() => saveCachedUser(SAMPLE_USER, brokenStorage));
    assert.equal(getCachedUser(brokenStorage), null);
  });
});

describe('Background session reconciliation (reconcileSessionCheck)', () => {
  test('preserves the cached user on network errors (offline PWA reopen)', () => {
    const result = reconcileSessionCheck({
      currentUser: SAMPLE_USER,
      status: null,
      networkError: true,
    });

    assert.deepEqual(result, {
      user: SAMPLE_USER,
      shouldPersist: false,
      shouldClear: false,
    });
  });

  test('preserves the cached user on transient 5xx server errors', () => {
    for (const status of [500, 502, 503, 504]) {
      const result = reconcileSessionCheck({
        currentUser: SAMPLE_USER,
        status,
        payload: null,
      });

      assert.deepEqual(result, {
        user: SAMPLE_USER,
        shouldPersist: false,
        shouldClear: false,
      });
    }
  });

  test('updates and persists the session when /api/auth/me returns a valid user', () => {
    const refreshedUser: SessionUser = {
      ...SAMPLE_USER,
      preferredCurrency: 'USD',
    };

    const result = reconcileSessionCheck({
      currentUser: SAMPLE_USER,
      status: 200,
      payload: { user: refreshedUser },
    });

    assert.deepEqual(result, {
      user: refreshedUser,
      shouldPersist: true,
      shouldClear: false,
    });
  });

  test('logs out and clears cache when /api/auth/me explicitly returns { user: null }', () => {
    const result = reconcileSessionCheck({
      currentUser: SAMPLE_USER,
      status: 200,
      payload: { user: null },
    });

    assert.deepEqual(result, {
      user: null,
      shouldPersist: false,
      shouldClear: true,
    });
  });

  test('logs out and clears cache on 401 or 403 responses', () => {
    for (const status of [401, 403]) {
      const result = reconcileSessionCheck({
        currentUser: SAMPLE_USER,
        status,
        payload: null,
      });

      assert.deepEqual(result, {
        user: null,
        shouldPersist: false,
        shouldClear: true,
      });
    }
  });
});
