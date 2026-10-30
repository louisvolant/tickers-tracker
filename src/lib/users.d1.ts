// D1 adapter for the account repository.
//
// The unique index on users.email (COLLATE NOCASE) is the real guard against
// duplicate registrations: the route no longer checks then writes, it inserts
// and maps the constraint error to EmailAlreadyExistsError.

import type { UserRecord } from './types';
import {
  EmailAlreadyExistsError,
  normalizeEmail,
  type NewUser,
  type UserRepository,
} from './users.types';

/**
 * Minimal structural types for the D1 binding.
 *
 * Using a local shape avoids depending on @cloudflare/workers-types in the app
 * type graph; the real D1 API is structurally compatible.
 */
export interface D1ResultLike {
  meta?: { changes?: number };
}

export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<D1ResultLike>;
  all<T = unknown>(): Promise<{ results: T[] }>;
}

export interface D1DatabaseLike {
  prepare(sql: string): D1StatementLike;
  batch(statements: D1StatementLike[]): Promise<unknown>;
}

const SELECT_BY_ID = 'SELECT * FROM users WHERE id = ? LIMIT 1';
const SELECT_BY_EMAIL = 'SELECT * FROM users WHERE email = ? COLLATE NOCASE LIMIT 1';
const INSERT_USER = `
  INSERT INTO users
    (id, email, username, hashed_password, google_id, preferred_currency, created_at, last_login_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`;
const INSERT_USER_IF_ABSENT = `
  INSERT OR IGNORE INTO users
    (id, email, username, hashed_password, google_id, preferred_currency, created_at, last_login_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`;

/** Whether a D1/SQLite error is a uniqueness violation. */
export function isUniqueConstraintError(error: unknown): boolean {
  const message = String(
    (error as { message?: unknown })?.message ??
      (error as { cause?: { message?: unknown } })?.cause?.message ??
      error
  );
  return /unique constraint failed/i.test(message) || /sqlite_constraint_unique/i.test(message);
}

function toRecord(row: any): UserRecord {
  return {
    id: String(row.id),
    email: String(row.email),
    username: String(row.username),
    hashedPassword: row.hashed_password ?? undefined,
    googleId: row.google_id ?? undefined,
    preferredCurrency: row.preferred_currency ?? undefined,
    createdAt: Number(row.created_at),
    lastLoginAt: row.last_login_at == null ? undefined : Number(row.last_login_at),
  };
}

function insertValues(user: UserRecord): unknown[] {
  return [
    user.id,
    normalizeEmail(user.email),
    user.username,
    user.hashedPassword ?? null,
    user.googleId ?? null,
    user.preferredCurrency ?? null,
    user.createdAt,
    user.lastLoginAt ?? null,
  ];
}

export class D1UserRepository implements UserRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  async findById(id: string): Promise<UserRecord | null> {
    const row = await this.db.prepare(SELECT_BY_ID).bind(id).first<any>();
    return row ? toRecord(row) : null;
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    const row = await this.db
      .prepare(SELECT_BY_EMAIL)
      .bind(normalizeEmail(email))
      .first<any>();
    return row ? toRecord(row) : null;
  }

  async create(user: NewUser): Promise<UserRecord> {
    const record: UserRecord = {
      ...user,
      email: normalizeEmail(user.email),
      lastLoginAt: user.lastLoginAt ?? user.createdAt,
    };

    try {
      await this.db.prepare(INSERT_USER).bind(...insertValues(record)).run();
      return record;
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        throw new EmailAlreadyExistsError(record.email);
      }
      throw err;
    }
  }

  async importUser(user: UserRecord): Promise<boolean> {
    const result = await this.db
      .prepare(INSERT_USER_IF_ABSENT)
      .bind(...insertValues(user))
      .run();

    return (result.meta?.changes ?? 0) > 0;
  }

  async updatePreferredCurrency(id: string, currency: string | null): Promise<void> {
    await this.db
      .prepare('UPDATE users SET preferred_currency = ? WHERE id = ?')
      .bind(currency, id)
      .run();
  }

  async updatePassword(id: string, hashedPassword: string): Promise<void> {
    await this.db
      .prepare('UPDATE users SET hashed_password = ? WHERE id = ?')
      .bind(hashedPassword, id)
      .run();
  }

  async updateLastLogin(id: string, at: number): Promise<void> {
    await this.db
      .prepare('UPDATE users SET last_login_at = ? WHERE id = ?')
      .bind(at, id)
      .run();
  }

  async linkGoogleAccount(email: string, googleId: string, username: string): Promise<UserRecord> {
    const cleanEmail = normalizeEmail(email);

    const existing = await this.findByEmail(cleanEmail);
    if (existing) {
      if (!existing.googleId) {
        await this.db
          .prepare('UPDATE users SET google_id = ? WHERE id = ? AND google_id IS NULL')
          .bind(googleId, existing.id)
          .run();
        return { ...existing, googleId };
      }
      return existing;
    }

    try {
      return await this.create({
        id: 'usr_' + crypto.randomUUID().replace(/-/g, ''),
        email: cleanEmail,
        username,
        googleId,
        createdAt: Date.now(),
      });
    } catch (err) {
      // Concurrent Google callback: the row appeared between the SELECT and the
      // INSERT. Re-read and link instead of failing the login.
      if (err instanceof EmailAlreadyExistsError) {
        const raced = await this.findByEmail(cleanEmail);
        if (raced) {
          if (!raced.googleId) {
            await this.db
              .prepare('UPDATE users SET google_id = ? WHERE id = ? AND google_id IS NULL')
              .bind(googleId, raced.id)
              .run();
            return { ...raced, googleId };
          }
          return raced;
        }
      }
      throw err;
    }
  }

  async delete(id: string): Promise<void> {
    await this.db.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
  }
}
