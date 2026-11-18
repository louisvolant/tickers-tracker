import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { setRuntimeEnv } from '../src/lib/env';
import { D1UserRepository } from '../src/lib/users.d1';
import { createSqliteDatabase, SqliteD1 } from './helpers/sqliteD1';
import { GET as googleAuth } from '../src/app/api/auth/google/route';
import { GET as googleCallback } from '../src/app/api/auth/callback/google/route';
import { GET as loginStatus } from '../src/app/api/auth/login-status/route';
import { getLoginTicket } from '../src/lib/oauth';
import { verifyLoginTicketState, SessionPayload } from '../src/lib/session';
import { verifySession } from '../src/lib/authCrypto';
import {
  clearStandaloneLogin,
  readPendingStandaloneLogin,
  STANDALONE_LOGIN_STORAGE_KEY,
  savePendingStandaloneLogin,
} from '../src/lib/pwaLogin';

const MIGRATIONS = ['0001_users.sql', '0003_last_login_at.sql'];

function migratedDatabase() {
  const db = createSqliteDatabase();
  for (const file of MIGRATIONS) {
    db.exec(fs.readFileSync(path.join(process.cwd(), 'migrations', file), 'utf8'));
  }
  return db;
}

function withD1(db: ReturnType<typeof migratedDatabase>): void {
  setRuntimeEnv({
    DB: new SqliteD1(db),
    AUTH_BACKEND: 'd1',
    SESSION_SECRET: 'test-session-secret-key-32b-long-abc',
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
  });
}

/** Client-generated nonce: 32 random bytes in base64url (43 characters). */
function randomNonce(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
}

function initiateRequest(nonce: string): NextRequest {
  return new NextRequest(`http://localhost:3000/api/auth/google?pwa=1&nonce=${nonce}`);
}

function statusRequest(nonce: string): NextRequest {
  return new NextRequest(`http://localhost:3000/api/auth/login-status?ticket=${nonce}`);
}

/** Mock the two Google calls and record every token-exchange body. */
function mockGoogleFetch(email: string, bodies: string[]): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('oauth2.googleapis.com/token')) {
      bodies.push(String(init?.body));
      return Response.json({ access_token: 'access-token' });
    }
    if (url.includes('googleapis.com/oauth2/v2/userinfo')) {
      return Response.json({ id: 'google-relay', email, name: 'Google Relay' });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

describe('Standalone (home-screen app) Google login relay', () => {
  test('initiation creates a signed ticket reference with a PKCE challenge', async () => {
    const db = migratedDatabase();
    withD1(db);

    try {
      const nonce = randomNonce();
      const response = await googleAuth(initiateRequest(nonce));
      assert.strictEqual(response.status, 307);

      const params = new URL(response.headers.get('location') || '').searchParams;
      assert.equal(params.get('code_challenge_method'), 'S256');

      // The state is a signed ticket reference, not the cookie-bound token
      // of the browser flow.
      const state = params.get('state') || '';
      assert.ok(state.includes('.'));
      assert.strictEqual(await verifyLoginTicketState(state), nonce);

      // The ticket holds the verifier its challenge was derived from.
      const ticket = await getLoginTicket(nonce);
      assert.ok(ticket?.codeVerifier);
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(ticket.codeVerifier)
      );
      assert.equal(params.get('code_challenge'), Buffer.from(digest).toString('base64url'));

      // No transaction cookie in the standalone flow: the callback will run
      // in a different cookie jar than this request.
      assert.ok(!(response.headers.get('set-cookie') || '').includes('tt_oauth_txn'));
    } finally {
      setRuntimeEnv(null);
    }
  });

  test('a malformed nonce falls back to the browser cookie flow', async () => {
    const db = migratedDatabase();
    withD1(db);

    try {
      const response = await googleAuth(
        new NextRequest('http://localhost:3000/api/auth/google?pwa=1&nonce=not-a-valid-nonce!')
      );
      assert.strictEqual(response.status, 307);
      assert.ok((response.headers.get('set-cookie') || '').includes('tt_oauth_txn'));
    } finally {
      setRuntimeEnv(null);
    }
  });

  test('the relay completes: callback stores the session, poll redeems it once', async () => {
    const db = migratedDatabase();
    const repo = new D1UserRepository(new SqliteD1(db));
    const email = `relay-${Date.now()}@gmail.com`;
    const nonce = randomNonce();

    withD1(db);
    const restoreFetch = mockGoogleFetch(email, []);

    try {
      // 1. Initiate from the standalone app.
      const init = await googleAuth(initiateRequest(nonce));
      const state = new URL(init.headers.get('location') || '').searchParams.get('state') || '';
      const verifier = (await getLoginTicket(nonce))?.codeVerifier;
      assert.ok(verifier);

      // 2. Pending ticket: the poll reports pending and sets no cookie.
      const pending = await loginStatus(statusRequest(nonce));
      assert.strictEqual((await pending.json()).status, 'pending');
      assert.ok(!(pending.headers.get('set-cookie') || '').includes('tt_session='));

      // 3. Safari completes the callback.
      restoreFetch();
      const bodies: string[] = [];
      mockGoogleFetch(email, bodies);

      const callback = await googleCallback(
        new NextRequest(
          `http://localhost:3000/api/auth/callback/google?code=relay-code&state=${encodeURIComponent(state)}`
        )
      );
      assert.strictEqual(callback.status, 303);
      assert.match(callback.headers.get('location') || '', /pwa_login=complete/);

      // Safari itself gets no session cookie: this window is not the app.
      assert.ok(!(callback.headers.get('set-cookie') || '').includes('tt_session='));

      // The exchange used the ticket's PKCE verifier.
      assert.ok(bodies[0]?.includes(`"code_verifier":"${verifier}"`));

      // 4. The callback linked (or created) the account.
      const account = await repo.findByEmail(email);
      assert.ok(account);
      assert.strictEqual(account.googleId, 'google-relay');

      // 5. The completed ticket holds a valid pre-signed session.
      const completed = await getLoginTicket(nonce);
      assert.ok(completed?.sessionValue);
      const payload = await verifySession<SessionPayload>(
        completed.sessionValue,
        'test-session-secret-key-32b-long-abc'
      );
      assert.equal(payload?.user.email, email);

      // 6. The app's poll redeems it exactly once: the session cookie is
      // set on the polling response, in the app's own cookie jar.
      const redeem = await loginStatus(statusRequest(nonce));
      const redeemBody = await redeem.json();
      assert.strictEqual(redeemBody.status, 'ok');
      assert.strictEqual(redeemBody.user.email, email);
      const setCookie = redeem.headers.get('set-cookie') || '';
      assert.ok(setCookie.includes('tt_session='));
      assert.ok(setCookie.includes('HttpOnly'));

      // 7. One-time only: a second poll finds nothing.
      const second = await loginStatus(statusRequest(nonce));
      assert.strictEqual((await second.json()).status, 'expired');
    } finally {
      restoreFetch();
      setRuntimeEnv(null);
    }
  });

  test('a completed ticket cannot be replayed through a second callback', async () => {
    const db = migratedDatabase();
    const email = `replay-${Date.now()}@gmail.com`;
    const nonce = randomNonce();

    withD1(db);
    const bodies: string[] = [];
    const restoreFetch = mockGoogleFetch(email, bodies);

    try {
      const init = await googleAuth(initiateRequest(nonce));
      const state = new URL(init.headers.get('location') || '').searchParams.get('state') || '';
      const callbackUrl = `http://localhost:3000/api/auth/callback/google?code=relay-code&state=${encodeURIComponent(state)}`;

      const first = await googleCallback(new NextRequest(callbackUrl));
      assert.strictEqual(first.status, 303);
      assert.match(first.headers.get('location') || '', /pwa_login=complete/);

      // Replaying the same code and state: the ticket is completed, so its
      // verifier is gone and the exchange never runs again.
      const second = await googleCallback(new NextRequest(callbackUrl));
      assert.strictEqual(second.status, 303);
      assert.match(second.headers.get('location') || '', /auth_error=invalid_state/);
      assert.strictEqual(bodies.length, 1);
    } finally {
      restoreFetch();
      setRuntimeEnv(null);
    }
  });

  test('a garbage state is rejected as invalid', async () => {
    const db = migratedDatabase();
    withD1(db);

    try {
      const response = await googleCallback(
        new NextRequest('http://localhost:3000/api/auth/callback/google?code=x&state=garbage')
      );
      assert.strictEqual(response.status, 303);
      assert.match(response.headers.get('location') || '', /auth_error=invalid_state/);
    } finally {
      setRuntimeEnv(null);
    }
  });

  test('an invalid ticket id is reported as invalid by the poll', async () => {
    const response = await loginStatus(
      new NextRequest('http://localhost:3000/api/auth/login-status?ticket=not-a-nonce')
    );
    assert.strictEqual((await response.json()).status, 'invalid');
  });
});

describe('Standalone login ticket storage (client side)', () => {
  function createMemoryStorage(initial: Record<string, string> = {}) {
    const store = new Map<string, string>(Object.entries(initial));
    return {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    };
  }

  test('round-trips a pending ticket through storage', () => {
    const storage = createMemoryStorage();
    savePendingStandaloneLogin({ nonce: randomNonce(), createdAt: Date.now() }, storage);

    const pending = readPendingStandaloneLogin(storage);
    assert.ok(pending);
    assert.match(pending.nonce, /^[A-Za-z0-9_-]{43}$/);
  });

  test('a ticket older than the server TTL is discarded', () => {
    const storage = createMemoryStorage();
    const stale = JSON.stringify({ nonce: randomNonce(), createdAt: Date.now() - 11 * 60 * 1000 });
    storage.setItem(STANDALONE_LOGIN_STORAGE_KEY, stale);

    assert.equal(readPendingStandaloneLogin(storage), null);
    assert.equal(storage.getItem(STANDALONE_LOGIN_STORAGE_KEY), null);
  });

  test('malformed entries are discarded, and clearing is a no-op when absent', () => {
    const storage = createMemoryStorage({ [STANDALONE_LOGIN_STORAGE_KEY]: '{oops' });
    assert.equal(readPendingStandaloneLogin(storage), null);

    clearStandaloneLogin(storage);
    assert.equal(storage.getItem(STANDALONE_LOGIN_STORAGE_KEY), null);
  });
});
