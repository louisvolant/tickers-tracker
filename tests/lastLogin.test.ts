import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { hashPassword } from '../src/lib/authCrypto';
import { setRuntimeEnv } from '../src/lib/env';
import { D1UserRepository } from '../src/lib/users.d1';
import { POST as login } from '../src/app/api/auth/login/route';
import { GET as googleCallback } from '../src/app/api/auth/callback/google/route';
import { createSqliteDatabase, SqliteD1 } from './helpers/sqliteD1';

const MIGRATIONS = ['0001_users.sql', '0003_last_login_at.sql'];

function migratedDatabase() {
  const db = createSqliteDatabase();
  for (const file of MIGRATIONS) {
    db.exec(fs.readFileSync(path.join(process.cwd(), 'migrations', file), 'utf8'));
  }
  return db;
}

function loginRequest(email: string, password: string): NextRequest {
  return new NextRequest('http://localhost:3000/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
}

function callbackRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/auth/callback/google?code=test-code');
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

describe('last_login_at storage', () => {
  test('D1 create defaults it to created_at and updateLastLogin refreshes it', async () => {
    const db = migratedDatabase();
    const repo = new D1UserRepository(new SqliteD1(db));
    const createdAt = Date.now() - 60_000;

    const created = await repo.create({
      id: 'usr_last_login',
      email: 'last-login@gmail.com',
      username: 'last-login',
      createdAt,
    });

    assert.strictEqual(created.lastLoginAt, createdAt);
    assert.strictEqual((await repo.findById(created.id))?.lastLoginAt, createdAt);

    await repo.updateLastLogin(created.id, Date.now());
    const stored = await repo.findById(created.id);
    assert.ok((stored?.lastLoginAt ?? 0) > createdAt);
  });

  test('password login refreshes last_login_at', async () => {
    const db = migratedDatabase();
    const repo = new D1UserRepository(new SqliteD1(db));
    const createdAt = Date.now() - 60_000;
    const email = 'password-login@gmail.com';
    const password = 'Password123!';

    const created = await repo.create({
      id: 'usr_password_login',
      email,
      username: 'password-login',
      hashedPassword: await hashPassword(password),
      createdAt,
      lastLoginAt: createdAt,
    });
    withD1(db);

    try {
      const response = await login(loginRequest(email, password));
      assert.strictEqual(response.status, 200);

      const stored = await repo.findById(created.id);
      assert.ok((stored?.lastLoginAt ?? 0) > createdAt);
    } finally {
      setRuntimeEnv(null);
    }
  });

  test('a Google callback refreshes last_login_at for an existing account', async () => {
    const db = migratedDatabase();
    const repo = new D1UserRepository(new SqliteD1(db));
    const createdAt = Date.now() - 60_000;
    const email = 'oauth-existing@gmail.com';

    const created = await repo.create({
      id: 'usr_oauth_existing',
      email,
      username: 'oauth-existing',
      createdAt,
      lastLoginAt: createdAt,
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) {
        return Response.json({ access_token: 'access-token' });
      }
      if (url.includes('googleapis.com/oauth2/v2/userinfo')) {
        return Response.json({ id: 'google-existing', email, name: 'OAuth Existing' });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;
    withD1(db);

    try {
      const response = await googleCallback(callbackRequest());
      assert.strictEqual(response.status, 303);

      const stored = await repo.findById(created.id);
      assert.strictEqual(stored?.googleId, 'google-existing');
      assert.ok((stored?.lastLoginAt ?? 0) > createdAt);
    } finally {
      setRuntimeEnv(null);
      globalThis.fetch = originalFetch;
    }
  });

  test('a first Google login creates the account with last_login_at set', async () => {
    const db = migratedDatabase();
    const repo = new D1UserRepository(new SqliteD1(db));
    const email = `oauth-new-${Date.now()}@gmail.com`;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) {
        return Response.json({ access_token: 'access-token' });
      }
      if (url.includes('googleapis.com/oauth2/v2/userinfo')) {
        return Response.json({ id: 'google-new', email, name: 'OAuth New' });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;
    withD1(db);

    try {
      const response = await googleCallback(callbackRequest());
      assert.strictEqual(response.status, 303);

      const stored = await repo.findByEmail(email);
      assert.ok(stored);
      assert.strictEqual(typeof stored.lastLoginAt, 'number');
      assert.ok((stored.lastLoginAt ?? 0) >= stored.createdAt);
    } finally {
      setRuntimeEnv(null);
      globalThis.fetch = originalFetch;
    }
  });
});
