// Account repository contract.
//
// The auth routes depend on this interface, never on KV or D1 directly. That is
// what allows the KV → D1 migration to be rolled out in stages (KV, dual-write,
// D1) and what makes the routes testable with an in-memory adapter.

import type { UserRecord } from './types';

export interface NewUser {
  id: string;
  email: string;
  username: string;
  hashedPassword?: string;
  googleId?: string;
  preferredCurrency?: string;
  createdAt: number;
  lastLoginAt?: number;
}

/** Thrown when the email (case-insensitive) is already registered. */
export class EmailAlreadyExistsError extends Error {
  constructor(email: string) {
    super(`An account with email ${email} already exists`);
    this.name = 'EmailAlreadyExistsError';
  }
}

export interface UserRepository {
  findById(id: string): Promise<UserRecord | null>;
  findByEmail(email: string): Promise<UserRecord | null>;
  create(user: NewUser): Promise<UserRecord>;

  /**
   * Insert a user if no row with the same id or email exists. Returns true when
   * a row was inserted. Used by the legacy KV → D1 import path, so it must be
   * idempotent.
   */
  importUser(user: UserRecord): Promise<boolean>;

  updatePreferredCurrency(id: string, currency: string | null): Promise<void>;
  updatePassword(id: string, hashedPassword: string): Promise<void>;
  /** Refresh the sign-in timestamp; callers must not fail a login if this does. */
  updateLastLogin(id: string, at: number): Promise<void>;
  linkGoogleAccount(email: string, googleId: string, username: string): Promise<UserRecord>;
  delete(id: string): Promise<void>;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
