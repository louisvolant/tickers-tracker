import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, passwordMarker, verifySession } from '../src/lib/authCrypto';
import {
  createSessionCookie,
  getSessionSecret,
  isPasswordMarkerValid,
  SessionPayload,
} from '../src/lib/session';

const user = { id: 'usr_rot', email: 'rot@example.com', username: 'rot' };

describe('session invalidation on password change', () => {
  test('re-hashing any password rotates the marker (fresh random salt)', async () => {
    const first = await hashPassword('Password123!');
    const second = await hashPassword('Password123!');
    const third = await hashPassword('OtherPassword456!');

    assert.ok(passwordMarker(first));
    assert.notEqual(passwordMarker(first), passwordMarker(second));
    assert.notEqual(passwordMarker(first), passwordMarker(third));
  });

  test('a token issued before the password change is rejected, one issued after is accepted', async () => {
    const oldHash = await hashPassword('Password123!');
    const newHash = await hashPassword('NewPassword456!');

    const oldCookie = await createSessionCookie(user, true, passwordMarker(oldHash));
    const newCookie = await createSessionCookie(user, true, passwordMarker(newHash));
    const markerlessCookie = await createSessionCookie(user, true);

    const oldPayload = await verifySession<SessionPayload>(oldCookie.value, getSessionSecret());
    const newPayload = await verifySession<SessionPayload>(newCookie.value, getSessionSecret());
    const markerlessPayload = await verifySession<SessionPayload>(
      markerlessCookie.value,
      getSessionSecret()
    );

    assert.equal(isPasswordMarkerValid(oldPayload, newHash), false, 'pre-change token must die');
    assert.equal(
      isPasswordMarkerValid(markerlessPayload, newHash),
      false,
      'a markerless token must not survive a password-owning account'
    );
    assert.equal(isPasswordMarkerValid(newPayload, newHash), true, 'post-change token survives');
  });

  test('passwordless (Google-only) accounts always pass', () => {
    assert.equal(isPasswordMarkerValid({ user }, undefined), true);
    assert.equal(isPasswordMarkerValid({ user, pwd: 'stale-marker' }, undefined), true);
  });

  test('a malformed stored hash degrades to signature-only validation', () => {
    assert.equal(isPasswordMarkerValid({ user, pwd: 'stale-marker' }, 'malformed-hash'), true);
    assert.equal(isPasswordMarkerValid({ user }, 'malformed-hash'), true);
  });
});
