import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { getSessionSecret } from '../src/lib/session';

// The value this repository used to hardcode as a fallback secret. It is
// public knowledge, so the secret policy must reject it explicitly.
const LEAKED_DEFAULT = 'ticker-tracker-production-super-secret-key-32b';

const env = process.env as Record<string, string | undefined>;
const ORIGINAL_SECRET = env.SESSION_SECRET;
const ORIGINAL_NODE_ENV = env.NODE_ENV;

describe('session secret policy', () => {
  test('accepts a configured secret of sufficient length', () => {
    env.SESSION_SECRET = 'a-configured-secret-that-is-long-enough-for-hmac';
    assert.equal(getSessionSecret(), 'a-configured-secret-that-is-long-enough-for-hmac');
  });

  test('rejects the value previously committed as the fallback', () => {
    env.SESSION_SECRET = LEAKED_DEFAULT;
    assert.throws(getSessionSecret, /rotate it now/i);
  });

  test('rejects a configured secret shorter than 32 characters', () => {
    env.SESSION_SECRET = 'short-secret';
    assert.throws(getSessionSecret, /at least 32 characters/i);
  });

  test('fails closed in production when no secret is configured', () => {
    delete env.SESSION_SECRET;
    env.NODE_ENV = 'production';
    try {
      assert.throws(getSessionSecret, /SESSION_SECRET is not configured/);
    } finally {
      restoreNodeEnv();
    }
  });

  test('generates an ephemeral random secret for unconfigured development', () => {
    delete env.SESSION_SECRET;
    env.NODE_ENV = 'development';
    try {
      const first = getSessionSecret();
      assert.ok(first.length >= 32, 'ephemeral secret must be at least 32 characters');
      assert.match(first, /^[0-9a-f]+$/, 'ephemeral secret must be random hex');
      assert.equal(getSessionSecret(), first, 'stable within one process');
      assert.notEqual(first, LEAKED_DEFAULT);
    } finally {
      restoreNodeEnv();
    }
  });
});

function restoreNodeEnv(): void {
  if (ORIGINAL_NODE_ENV === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = ORIGINAL_NODE_ENV;

  if (ORIGINAL_SECRET === undefined) delete env.SESSION_SECRET;
  else env.SESSION_SECRET = ORIGINAL_SECRET;
}
