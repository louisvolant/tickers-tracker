// Dual-write adapter used during the KV → D1 transition.
//
// D1 is the source of truth. KV is kept in sync so a rollback (`AUTH_BACKEND=kv`)
// loses nothing, and reads fall back to KV so legacy users can still log in. A KV
// hit is imported into D1 lazily, which makes the transition self-healing.

import type { UserRecord } from './types';
import type { NewUser, UserRepository } from './users.types';

export class DualWriteUserRepository implements UserRepository {
  constructor(
    private readonly primary: UserRepository,
    private readonly legacy: UserRepository
  ) {}

  private async importLegacyUser(user: UserRecord): Promise<void> {
    try {
      await this.primary.importUser(user);
    } catch (err) {
      // A failed lazy import must not break the login: the user is still served
      // from KV, and a later read can retry the import.
      console.warn('D1 lazy user import failed:', err);
    }
  }

  async findById(id: string): Promise<UserRecord | null> {
    const primary = await this.primary.findById(id);
    if (primary) return primary;

    const legacy = await this.legacy.findById(id);
    if (legacy) await this.importLegacyUser(legacy);
    return legacy;
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    const primary = await this.primary.findByEmail(email);
    if (primary) return primary;

    const legacy = await this.legacy.findByEmail(email);
    if (legacy) await this.importLegacyUser(legacy);
    return legacy;
  }

  async create(user: NewUser): Promise<UserRecord> {
    const created = await this.primary.create(user);

    try {
      await this.legacy.importUser(created);
    } catch (err) {
      // The D1 write succeeded; a KV mirror failure must not fail registration.
      console.warn('KV mirror write failed during dual-write:', err);
    }

    return created;
  }

  async importUser(user: UserRecord): Promise<boolean> {
    return this.primary.importUser(user);
  }

  async updatePreferredCurrency(id: string, currency: string | null): Promise<void> {
    await this.primary.updatePreferredCurrency(id, currency);

    try {
      await this.legacy.updatePreferredCurrency(id, currency);
    } catch (err) {
      console.warn('KV mirror update failed during dual-write:', err);
    }
  }

  async updatePassword(id: string, hashedPassword: string): Promise<void> {
    await this.primary.updatePassword(id, hashedPassword);

    try {
      await this.legacy.updatePassword(id, hashedPassword);
    } catch (err) {
      console.warn('KV mirror password update failed during dual-write:', err);
    }
  }

  async updateLastLogin(id: string, at: number): Promise<void> {
    await this.primary.updateLastLogin(id, at);

    try {
      await this.legacy.updateLastLogin(id, at);
    } catch (err) {
      // D1 already has the timestamp; a legacy mirror failure must not fail login.
      console.warn('KV mirror last-login update failed during dual-write:', err);
    }
  }

  async linkGoogleAccount(email: string, googleId: string, username: string): Promise<UserRecord> {
    // Resolve through both backends first, so a KV-only account keeps its id
    // when it is linked to Google.
    const existing = await this.findByEmail(email);

    if (existing) {
      const updated = existing.googleId
        ? existing
        : await this.primary.linkGoogleAccount(email, googleId, username);

      try {
        await this.legacy.linkGoogleAccount(email, googleId, username);
      } catch (err) {
        console.warn('KV mirror Google link failed during dual-write:', err);
      }

      return updated;
    }

    const created = await this.primary.linkGoogleAccount(email, googleId, username);

    try {
      await this.legacy.importUser(created);
    } catch (err) {
      console.warn('KV mirror Google create failed during dual-write:', err);
    }

    return created;
  }

  async delete(id: string): Promise<void> {
    await this.primary.delete(id);

    try {
      await this.legacy.delete(id);
    } catch (err) {
      console.warn('KV mirror delete failed during dual-write:', err);
    }
  }
}
