import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionCookie, getSessionSecret, SessionPayload } from '../src/lib/session';
import { verifySession } from '../src/lib/authCrypto';
import { SessionUser } from '../src/lib/types';

const user: SessionUser = {
  id: 'usr_test',
  email: 'test@example.com',
  username: 'Tester',
};

describe('Session cookie', () => {
  test('builds a 30-day HttpOnly SameSite=Lax session cookie', async () => {
    const before = Date.now();
    const cookie = await createSessionCookie(user, true);

    assert.equal(cookie.name, 'tt_session');
    assert.equal(cookie.options.httpOnly, true);
    assert.equal(cookie.options.secure, true);
    assert.equal(cookie.options.sameSite, 'lax');
    assert.equal(cookie.options.path, '/');
    assert.equal(cookie.options.maxAge, 30 * 24 * 60 * 60);
    assert.ok(cookie.options.expires.getTime() >= before + 29 * 24 * 60 * 60 * 1000);

    const payload = await verifySession<SessionPayload>(cookie.value, getSessionSecret());
    assert.ok(payload);
    assert.deepEqual(payload.user, user);
  });

  test('does not force Secure on plain HTTP development origins', async () => {
    const cookie = await createSessionCookie(user, false);
    assert.equal(cookie.options.secure, false);
  });

  test('embeds the password marker so rotation can invalidate old tokens', async () => {
    const cookie = await createSessionCookie(user, true, 'salt-marker-01');
    const payload = await verifySession<SessionPayload>(cookie.value, getSessionSecret());
    assert.equal(payload?.pwd, 'salt-marker-01');
  });
});
