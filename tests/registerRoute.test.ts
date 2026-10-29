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

describe('POST /api/auth/register', () => {
  test('rejects a cross-site origin before creating an account', async () => {
    const email = `csrf_${Date.now()}@gmail.com`;
    const response = await POST(
      registerRequest({ email, password: PASSWORD }, 'https://evil.example')
    );

    assert.strictEqual(response.status, 403);
    assert.deepStrictEqual(await response.json(), { error: 'invalid_origin' });
    assert.strictEqual(await getUserRepository().findByEmail(email), null);
  });
});
