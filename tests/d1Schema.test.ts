import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The unique email index is the database-level guard against duplicate
 * registrations. This test keeps the invariant visible even if the migration is
 * edited later.
 */
describe('D1 users migration', () => {
  const sql = readFileSync(path.join(process.cwd(), 'migrations/0001_users.sql'), 'utf-8');
  const lastLoginSql = readFileSync(
    path.join(process.cwd(), 'migrations/0003_last_login_at.sql'),
    'utf-8'
  );

  test('creates the users table', () => {
    assert.match(sql, /CREATE TABLE users/i);
    assert.match(sql, /\bid\s+TEXT PRIMARY KEY/i);
    assert.match(sql, /\bemail\s+TEXT NOT NULL/i);
  });

  test('enforces a case-insensitive unique email', () => {
    assert.match(
      sql,
      /CREATE UNIQUE INDEX users_email_unique ON users\(email COLLATE NOCASE\)/i
    );
  });

  test('allows one Google identity per account without blocking password-only users', () => {
    assert.match(
      sql,
      /CREATE UNIQUE INDEX users_google_id_unique ON users\(google_id\) WHERE google_id IS NOT NULL/i
    );
  });

  test('adds a nullable last_login_at using the created_at timestamp unit', () => {
    assert.match(lastLoginSql, /ALTER TABLE users ADD COLUMN last_login_at INTEGER/i);
    assert.doesNotMatch(lastLoginSql, /NOT NULL/i);
  });
});
