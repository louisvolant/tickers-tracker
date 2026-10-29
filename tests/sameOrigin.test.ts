import { test, describe } from 'node:test';
import assert from 'node:assert';
import { assertSameOrigin } from '../src/lib/sameOrigin';

const REQUEST_URL = 'https://www.tickertracker.net/api/tickers';

function requestWith(headers: Record<string, string>, url = REQUEST_URL): Request {
  return new Request(url, { method: 'POST', headers });
}

async function assertForbidden(response: Response | null): Promise<void> {
  assert.ok(response, 'expected a 403 response');
  assert.strictEqual(response.status, 403);
  assert.deepStrictEqual(await response.json(), { error: 'invalid_origin' });
}

function withEnv(name: string, value: string | undefined, fn: () => void): void {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;

  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

describe('Same-origin guard', () => {
  test('allows requests without Origin or Referer', () => {
    assert.strictEqual(assertSameOrigin(requestWith({})), null);
  });

  test('allows the configured public site and its apex/www aliases', () => {
    withEnv('NEXT_PUBLIC_APP_URL', 'https://www.tickertracker.net', () => {
      assert.strictEqual(
        assertSameOrigin(requestWith({ origin: 'https://www.tickertracker.net' }, 'https://preview.example.dev/api')),
        null
      );
      assert.strictEqual(
        assertSameOrigin(requestWith({ origin: 'https://tickertracker.net' }, 'https://preview.example.dev/api')),
        null
      );
    });
  });

  test('allows the current request host and preview hosts', () => {
    assert.strictEqual(
      assertSameOrigin(requestWith({ origin: 'https://preview.example.dev' }, 'https://preview.example.dev/api')),
      null
    );
    assert.strictEqual(
      assertSameOrigin(
        requestWith(
          { origin: 'https://preview.example.dev', host: 'preview.example.dev' },
          'http://internal:3000/api'
        )
      ),
      null
    );
    assert.strictEqual(
      assertSameOrigin(
        requestWith({
          origin: 'https://preview.example.dev',
          'x-forwarded-host': 'preview.example.dev, edge.example.dev',
        })
      ),
      null
    );
  });

  test('allows local development and test hosts', () => {
    for (const origin of [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://[::1]:3000',
      'http://my-mac.local:3000',
    ]) {
      assert.strictEqual(
        assertSameOrigin(requestWith({ origin }, 'http://localhost:3000/api/tickers')),
        null,
        origin
      );
    }
  });

  test('rejects a cross-site origin', async () => {
    await assertForbidden(
      assertSameOrigin(requestWith({ origin: 'https://evil.example' }))
    );
  });

  test('rejects malformed and opaque origins', async () => {
    await assertForbidden(assertSameOrigin(requestWith({ origin: 'not a url' })));
    await assertForbidden(assertSameOrigin(requestWith({ origin: 'null' })));
  });

  test('falls back to the Referer when Origin is absent', () => {
    assert.strictEqual(
      assertSameOrigin(requestWith({ referer: 'https://www.tickertracker.net/dashboard' })),
      null
    );
  });

  test('rejects a cross-site Referer when Origin is absent', async () => {
    await assertForbidden(
      assertSameOrigin(requestWith({ referer: 'https://evil.example/attack' }))
    );
  });
});
