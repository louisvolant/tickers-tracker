import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { setRuntimeEnv } from '../src/lib/env';
import { GET as googleAuth } from '../src/app/api/auth/google/route';
import {
  createOAuthTransaction,
  parseOAuthTransaction,
  OAUTH_TXN_COOKIE,
  OAUTH_TXN_COOKIE_PATH,
} from '../src/lib/oauth';

describe('OAuth transaction (CSRF state + PKCE)', () => {
  test('creates a transaction whose challenge is SHA-256 of the verifier', async () => {
    const txn = await createOAuthTransaction();

    // 32 random bytes in base64url = 43 unreserved characters (RFC 7636 range).
    assert.equal(txn.state.length, 43);
    assert.equal(txn.codeVerifier.length, 43);
    assert.notEqual(txn.state, txn.codeVerifier);

    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(txn.codeVerifier)
    );
    assert.equal(txn.codeChallenge, Buffer.from(digest).toString('base64url'));

    // The cookie value round-trips to exactly the same transaction.
    assert.deepEqual(parseOAuthTransaction(txn.cookieValue), {
      state: txn.state,
      codeVerifier: txn.codeVerifier,
    });
  });

  test('never reuses a state or verifier between transactions', async () => {
    const a = await createOAuthTransaction();
    const b = await createOAuthTransaction();

    assert.notEqual(a.state, b.state);
    assert.notEqual(a.codeVerifier, b.codeVerifier);
  });

  test('rejects missing, malformed or tampered transaction cookies', async () => {
    assert.equal(parseOAuthTransaction(null), null);
    assert.equal(parseOAuthTransaction(''), null);

    // Valid base64url of something that is not the transaction JSON.
    assert.equal(
      parseOAuthTransaction(Buffer.from('not json').toString('base64url')),
      null
    );

    // Missing verifier.
    assert.equal(
      parseOAuthTransaction(Buffer.from(JSON.stringify({ state: 'abc' })).toString('base64url')),
      null
    );

    // Verifier outside the RFC 7636 length range.
    assert.equal(
      parseOAuthTransaction(
        Buffer.from(JSON.stringify({ state: 'abc', codeVerifier: 'too-short' })).toString('base64url')
      ),
      null
    );
  });

  test('the authorize redirect carries state + S256 challenge and sets a scoped cookie', async () => {
    setRuntimeEnv({
      GOOGLE_CLIENT_ID: 'test-client-id',
      NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
    });

    try {
      const response = await googleAuth(
        new NextRequest('http://localhost:3000/api/auth/google')
      );
      assert.equal(response.status, 307);

      const location = response.headers.get('location') || '';
      assert.ok(location.includes('accounts.google.com/o/oauth2/v2/auth'));

      const params = new URL(location).searchParams;
      assert.ok(params.get('state'), 'authorize URL must carry a state');
      assert.ok(params.get('code_challenge'), 'authorize URL must carry a PKCE challenge');
      assert.equal(params.get('code_challenge_method'), 'S256');

      const setCookie = response.headers.get('set-cookie') || '';
      assert.ok(setCookie.includes(`${OAUTH_TXN_COOKIE}=`), 'must set the transaction cookie');
      assert.ok(setCookie.includes('HttpOnly'));
      assert.ok(setCookie.includes(`Path=${OAUTH_TXN_COOKIE_PATH}`));
    } finally {
      setRuntimeEnv(null);
    }
  });
});
