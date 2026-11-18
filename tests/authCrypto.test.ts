import { test, describe } from 'node:test';
import assert from 'node:assert';
import { hashPassword, verifyPassword, signSession, verifySession } from '../src/lib/authCrypto.ts';

describe('Auth Crypto Utilities', () => {
  test('should hash and verify a password correctly', async () => {
    const password = 'SuperSecretPassword123!';
    const hash = await hashPassword(password);
    assert.ok(hash.includes('.'));
    
    const isValid = await verifyPassword(password, hash);
    assert.strictEqual(isValid, true, 'Correct password should verify');

    const isInvalid = await verifyPassword('WrongPassword', hash);
    assert.strictEqual(isInvalid, false, 'Incorrect password should fail verification');
  });

  test('should sign and verify session tokens with secret', async () => {
    const secret = 'test-secret-key-32-bytes-long-12345';
    const userPayload = { id: 'usr_123', email: 'test@example.com', username: 'trader1' };
    const token = await signSession({ user: userPayload, exp: Date.now() + 60000 }, secret);

    assert.ok(token.includes('.'));
    // verifySession returns the full signed payload, not just the user.
    const verified = await verifySession<{ user: typeof userPayload }>(token, secret);
    assert.deepStrictEqual(verified?.user, userPayload);

    // Tampered token should fail
    const tampered = token.slice(0, -4) + 'abcd';
    const failedUser = await verifySession(tampered, secret);
    assert.strictEqual(failedUser, null);

    // Wrong secret should fail
    const wrongSecretUser = await verifySession(token, 'another-secret-key-999');
    assert.strictEqual(wrongSecretUser, null);
  });
});
