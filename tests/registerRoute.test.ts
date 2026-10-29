import { test, describe } from 'node:test';
import assert from 'node:assert';
import { NextRequest } from 'next/server';
import { POST } from '../src/app/api/auth/register/route';
import { getUserRepository } from '../src/lib/users';

// The route resolves the KV adapter when no D1 binding is present, which is the
// case in unit tests.
process.env.AUTH_BACKEND = 'kv';

const PASSWORD = 'StrongPass123!';

function registerRequest(
  body: Record<string, unknown>,
  origin?: string
): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (origin) headers.origin = origin;

  return new NextRequest('http://localhost:3000/api/auth/register', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function deleteAccount(email: string): Promise<void> {
  const repo = getUserRepository();
  const user = await repo.findByEmail(email);
  if (user) await repo.delete(user.id);
}

async function withPolicyEnforced<T>(fn: () => Promise<T>): Promise<T> {
  const env = process.env as Record<string, string | undefined>;
  const previousE2E = env.E2E;
  const previousNodeEnv = env.NODE_ENV;
  delete env.E2E;
  env.NODE_ENV = 'production';

  try {
    return await fn();
  } finally {
    if (previousE2E === undefined) delete env.E2E;
    else env.E2E = previousE2E;
    if (previousNodeEnv === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = previousNodeEnv;
  }
}

describe('POST /api/auth/register', () => {
  test('rejects a reserved email domain without creating an account', async () => {
    await withPolicyEnforced(async () => {
      const email = `bot_${Date.now()}@example.com`;
      const response = await POST(registerRequest({ email, password: PASSWORD }));

      assert.strictEqual(response.status, 400);
      assert.deepStrictEqual(await response.json(), {
        error: 'Please use a real email address.',
      });
      assert.strictEqual(await getUserRepository().findByEmail(email), null);
    });
  });

  test('creates an account for a real domain', async () => {
    await withPolicyEnforced(async () => {
      const email = `real_${Date.now()}@gmail.com`;

      try {
        const response = await POST(registerRequest({ email, password: PASSWORD }));

        assert.strictEqual(response.status, 201);
        const body = await response.json();
        assert.strictEqual(body.user.email, email);
        assert.ok(await getUserRepository().findByEmail(email));
      } finally {
        await deleteAccount(email);
      }
    });
  });

  test('still returns 409 for a duplicate email', async () => {
    await withPolicyEnforced(async () => {
      const email = `duplicate_${Date.now()}@gmail.com`;

      try {
        const first = await POST(registerRequest({ email, password: PASSWORD }));
        assert.strictEqual(first.status, 201);

        const second = await POST(registerRequest({ email, password: PASSWORD }));
        assert.strictEqual(second.status, 409);

        const repo = getUserRepository();
        assert.ok(await repo.findByEmail(email));
      } finally {
        await deleteAccount(email);
      }
    });
  });

  test('rejects a cross-site origin before creating an account', async () => {
    await withPolicyEnforced(async () => {
      const email = `csrf_${Date.now()}@gmail.com`;
      const response = await POST(
        registerRequest({ email, password: PASSWORD }, 'https://evil.example')
      );

      assert.strictEqual(response.status, 403);
      assert.deepStrictEqual(await response.json(), { error: 'invalid_origin' });
      assert.strictEqual(await getUserRepository().findByEmail(email), null);
    });
  });

  test('accepts @example.com only when the e2e flag is set', async () => {
    const env = process.env as Record<string, string | undefined>;
    const previousE2E = env.E2E;
    const previousNodeEnv = env.NODE_ENV;
    env.E2E = '1';
    env.NODE_ENV = 'production';
    const email = `e2e_${Date.now()}@example.com`;

    try {
      const response = await POST(registerRequest({ email, password: PASSWORD }));

      assert.strictEqual(response.status, 201);
      assert.ok(await getUserRepository().findByEmail(email));
    } finally {
      await deleteAccount(email);
      if (previousE2E === undefined) delete env.E2E;
      else env.E2E = previousE2E;
      if (previousNodeEnv === undefined) delete env.NODE_ENV;
      else env.NODE_ENV = previousNodeEnv;
    }
  });
});
