// In-memory UserRepository for unit tests.
//
// The auth routes depend on the interface, so this adapter exercises exactly the
// same contract as D1 without needing a database.

import type { UserRecord } from '../../src/lib/types';
import {
  EmailAlreadyExistsError,
  normalizeEmail,
  type NewUser,
  type UserRepository,
} from '../../src/lib/users.types';

export class MemoryUserRepository implements UserRepository {
  private readonly users = new Map<string, UserRecord>();

  async findById(id: string): Promise<UserRecord | null> {
    return this.users.get(id) ?? null;
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    const clean = normalizeEmail(email);
    for (const user of this.users.values()) {
      if (user.email === clean) return user;
    }
    return null;
  }

  async create(user: NewUser): Promise<UserRecord> {
    const email = normalizeEmail(user.email);
    if (await this.findByEmail(email)) throw new EmailAlreadyExistsError(email);

    const record: UserRecord = {
      ...user,
      email,
      lastLoginAt: user.lastLoginAt ?? user.createdAt,
    };
    this.users.set(record.id, record);
    return record;
  }

  async importUser(user: UserRecord): Promise<boolean> {
    if (this.users.has(user.id) || (await this.findByEmail(user.email))) return false;

    this.users.set(user.id, { ...user, email: normalizeEmail(user.email) });
    return true;
  }

  async updatePreferredCurrency(id: string, currency: string | null): Promise<void> {
    const user = this.users.get(id);
    if (user) user.preferredCurrency = currency ?? undefined;
  }

  async updatePassword(id: string, hashedPassword: string): Promise<void> {
    const user = this.users.get(id);
    if (user) user.hashedPassword = hashedPassword;
  }

  async updateLastLogin(id: string, at: number): Promise<void> {
    const user = this.users.get(id);
    if (user) user.lastLoginAt = at;
  }

  async linkGoogleAccount(email: string, googleId: string, username: string): Promise<UserRecord> {
    const clean = normalizeEmail(email);
    const existing = await this.findByEmail(clean);

    if (existing) {
      if (!existing.googleId) existing.googleId = googleId;
      return existing;
    }

    return this.create({
      id: 'usr_' + crypto.randomUUID().replace(/-/g, ''),
      email: clean,
      username,
      googleId,
      createdAt: Date.now(),
    });
  }

  async delete(id: string): Promise<void> {
    this.users.delete(id);
  }

  /** Test helper: number of stored accounts. */
  size(): number {
    return this.users.size;
  }
}
