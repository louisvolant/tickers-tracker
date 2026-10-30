import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { MemoryUserRepository } from './helpers/memoryUsers.ts';
import { EmailAlreadyExistsError } from '../src/lib/users.types.ts';
import { isUniqueConstraintError } from '../src/lib/users.d1.ts';
import { DualWriteUserRepository } from '../src/lib/users.dual.ts';

const CREATED_AT = 1_800_000_000_000;

function newUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'usr_1',
    email: 'Trader@Example.com',
    username: 'trader',
    hashedPassword: 'pbkdf2$hash',
    createdAt: CREATED_AT,
    ...overrides,
  } as any;
}

describe('User repository contract', () => {
  let repo: MemoryUserRepository;

  beforeEach(() => {
    repo = new MemoryUserRepository();
  });

  test('creates a user and normalises the email', async () => {
    const created = await repo.create(newUser());

    assert.strictEqual(created.email, 'trader@example.com');
    assert.strictEqual(created.lastLoginAt, CREATED_AT);

    const byId = await repo.findById('usr_1');
    const byEmail = await repo.findByEmail('  TRADER@example.COM ');

    assert.strictEqual(byId?.username, 'trader');
    assert.strictEqual(byEmail?.id, 'usr_1');
  });

  test('updates last_login_at on sign-in', async () => {
    await repo.create(newUser());

    await repo.updateLastLogin('usr_1', CREATED_AT + 10_000);

    assert.strictEqual((await repo.findById('usr_1'))?.lastLoginAt, CREATED_AT + 10_000);
  });

  test('rejects a duplicate email case-insensitively', async () => {
    await repo.create(newUser());

    await assert.rejects(
      () =>
        repo.create(
          newUser({ id: 'usr_2', email: 'TRADER@EXAMPLE.COM', username: 'other' })
        ),
      EmailAlreadyExistsError
    );

    assert.strictEqual(repo.size(), 1);
  });

  test('importUser is idempotent and preserves the original id', async () => {
    const user = await repo.create(newUser());

    assert.strictEqual(await repo.importUser(user), false, 'already present');

    const other = new MemoryUserRepository();
    assert.strictEqual(await other.importUser(user), true, 'first import');
    assert.strictEqual(await other.importUser(user), false, 'second import');
    assert.strictEqual((await other.findById('usr_1'))?.email, 'trader@example.com');
  });

  test('updates the preferred currency and the password on one record', async () => {
    await repo.create(newUser());

    await repo.updatePreferredCurrency('usr_1', 'EUR');
    await repo.updatePassword('usr_1', 'pbkdf2$new');

    const user = await repo.findById('usr_1');
    assert.strictEqual(user?.preferredCurrency, 'EUR');
    assert.strictEqual(user?.hashedPassword, 'pbkdf2$new');
  });

  test('links Google to an existing password account without losing the hash', async () => {
    await repo.create(newUser());

    const linked = await repo.linkGoogleAccount('trader@example.com', 'google-123', 'Trader');

    assert.strictEqual(linked.id, 'usr_1');
    assert.strictEqual(linked.googleId, 'google-123');
    assert.strictEqual(linked.hashedPassword, 'pbkdf2$hash');
    assert.strictEqual(repo.size(), 1);
  });

  test('creates a Google-only account when the email is unknown', async () => {
    const created = await repo.linkGoogleAccount('new@example.com', 'google-456', 'New User');

    assert.strictEqual(created.email, 'new@example.com');
    assert.strictEqual(created.googleId, 'google-456');
    assert.strictEqual(created.hashedPassword, undefined);
    assert.strictEqual(repo.size(), 1);
  });

  test('deletes an account', async () => {
    await repo.create(newUser());

    await repo.delete('usr_1');

    assert.strictEqual(await repo.findById('usr_1'), null);
    assert.strictEqual(await repo.findByEmail('trader@example.com'), null);
  });
});

describe('D1 unique-constraint classification', () => {
  test('recognises a users.email uniqueness violation', () => {
    assert.strictEqual(
      isUniqueConstraintError(
        new Error('D1_ERROR: UNIQUE constraint failed: users.email: SQLITE_CONSTRAINT')
      ),
      true
    );
    assert.strictEqual(isUniqueConstraintError(new Error('SQLITE_CONSTRAINT_UNIQUE')), true);
  });

  test('does not swallow unrelated failures', () => {
    assert.strictEqual(isUniqueConstraintError(new Error('network connection lost')), false);
    assert.strictEqual(isUniqueConstraintError(new Error('no such table: users')), false);
  });
});

describe('Dual-write account repository (transition)', () => {
  let primary: MemoryUserRepository;
  let legacy: MemoryUserRepository;
  let repo: DualWriteUserRepository;

  beforeEach(() => {
    primary = new MemoryUserRepository();
    legacy = new MemoryUserRepository();
    repo = new DualWriteUserRepository(primary, legacy);
  });

  test('create writes the account to both backends', async () => {
    await repo.create(newUser());

    assert.ok(await primary.findByEmail('trader@example.com'));
    assert.ok(await legacy.findByEmail('trader@example.com'));
  });

  test('a KV-only account is readable and imported into D1 on first read', async () => {
    await legacy.importUser({
      id: 'usr_legacy',
      email: 'legacy@example.com',
      username: 'legacy',
      createdAt: CREATED_AT,
    });

    const found = await repo.findByEmail('legacy@example.com');

    assert.strictEqual(found?.id, 'usr_legacy');
    assert.strictEqual((await primary.findById('usr_legacy'))?.email, 'legacy@example.com');
  });

  test('linking Google keeps the KV account id and mirrors both rows', async () => {
    await legacy.importUser({
      id: 'usr_legacy',
      email: 'legacy@example.com',
      username: 'legacy',
      createdAt: CREATED_AT,
    });

    const linked = await repo.linkGoogleAccount('legacy@example.com', 'google-1', 'Legacy');

    assert.strictEqual(linked.id, 'usr_legacy');
    assert.strictEqual((await primary.findById('usr_legacy'))?.googleId, 'google-1');
    assert.strictEqual((await legacy.findById('usr_legacy'))?.googleId, 'google-1');
  });

  test('password, currency and last-login updates are mirrored', async () => {
    await repo.create(newUser());

    await repo.updatePassword('usr_1', 'pbkdf2$new');
    await repo.updatePreferredCurrency('usr_1', 'EUR');
    await repo.updateLastLogin('usr_1', CREATED_AT + 20_000);

    for (const backend of [primary, legacy]) {
      const user = await backend.findById('usr_1');
      assert.strictEqual(user?.hashedPassword, 'pbkdf2$new');
      assert.strictEqual(user?.preferredCurrency, 'EUR');
      assert.strictEqual(user?.lastLoginAt, CREATED_AT + 20_000);
    }
  });

  test('delete removes the account from both backends', async () => {
    await repo.create(newUser());

    await repo.delete('usr_1');

    assert.strictEqual(await primary.findById('usr_1'), null);
    assert.strictEqual(await legacy.findById('usr_1'), null);
  });
});
