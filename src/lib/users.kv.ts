// KV adapter for the account repository.
//
// This is the pre-D1 behaviour, kept while the migration runs and available as
// a rollback path (`AUTH_BACKEND=kv`). It writes the duplicated by-email/by-id
// keys, so it is intentionally not used once the D1 contract phase is complete.

import { kvDelete, kvGet, kvPut } from './kv';
import type { UserRecord } from './types';
import {
  EmailAlreadyExistsError,
  normalizeEmail,
  type NewUser,
  type UserRepository,
} from './users.types';

function emailKey(email: string): string {
  return `user:by-email:${normalizeEmail(email)}`;
}

function idKey(id: string): string {
  return `user:by-id:${id}`;
}

export class KvUserRepository implements UserRepository {
  async findById(id: string): Promise<UserRecord | null> {
    return kvGet<UserRecord>(idKey(id));
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    return kvGet<UserRecord>(emailKey(email));
  }

  async create(user: NewUser): Promise<UserRecord> {
    const email = normalizeEmail(user.email);

    // Legacy KV path: the pre-check and the two writes are not atomic, which is
    // exactly the defect D1 removes. Kept only for the transition.
    const existing = await this.findByEmail(email);
    if (existing) throw new EmailAlreadyExistsError(email);

    const record: UserRecord = {
      ...user,
      email,
      lastLoginAt: user.lastLoginAt ?? user.createdAt,
    };
    await kvPut(emailKey(email), record);
    await kvPut(idKey(record.id), record);
    return record;
  }

  async importUser(user: UserRecord): Promise<boolean> {
    const email = normalizeEmail(user.email);
    const [byId, byEmail] = await Promise.all([
      this.findById(user.id),
      this.findByEmail(email),
    ]);
    if (byId || byEmail) return false;

    const record: UserRecord = { ...user, email };
    await kvPut(emailKey(email), record);
    await kvPut(idKey(record.id), record);
    return true;
  }

  async updatePreferredCurrency(id: string, currency: string | null): Promise<void> {
    const user = await this.findById(id);
    if (!user) return;

    user.preferredCurrency = currency ?? undefined;
    await kvPut(emailKey(user.email), user);
    await kvPut(idKey(user.id), user);
  }

  async updatePassword(id: string, hashedPassword: string): Promise<void> {
    const user = await this.findById(id);
    if (!user) return;

    user.hashedPassword = hashedPassword;
    await kvPut(emailKey(user.email), user);
    await kvPut(idKey(user.id), user);
  }

  async updateLastLogin(id: string, at: number): Promise<void> {
    const user = await this.findById(id);
    if (!user) return;

    user.lastLoginAt = at;
    await kvPut(emailKey(user.email), user);
    await kvPut(idKey(user.id), user);
  }

  async linkGoogleAccount(email: string, googleId: string, username: string): Promise<UserRecord> {
    const cleanEmail = normalizeEmail(email);
    const existing = await this.findByEmail(cleanEmail);

    if (existing) {
      if (!existing.googleId) {
        existing.googleId = googleId;
        await kvPut(emailKey(cleanEmail), existing);
        await kvPut(idKey(existing.id), existing);
      }
      return existing;
    }

    return this.create({
      id: 'usr_' + crypto.randomUUID().replace(/-/g, ''),
      email: cleanEmail,
      username,
      googleId,
      createdAt: Date.now(),
    });
  }

  async delete(id: string): Promise<void> {
    const user = await this.findById(id);
    if (user) await kvDelete(emailKey(user.email));
    await kvDelete(idKey(id));
  }
}
