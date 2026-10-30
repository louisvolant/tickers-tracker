// Watchlist storage.
//
// During the KV → D1 migration the app runs in one of three modes:
//   - `kv`  : the original one-array-per-user KV layout (also the automatic
//             fallback when no D1 binding exists, e.g. unit tests);
//   - `dual`: D1 is the source of truth, KV is mirrored for rollback and is
//             read only for users that have not been imported yet;
//   - `d1`  : SQL only, used after the backfill has been verified.
//
// The API routes depend on this interface, never on a binding directly, which
// keeps the JSON contract unchanged across the three modes.

import { getEnvVar } from './env';
import { kvDelete, kvGet, kvListAll, kvPut } from './kv';
import type { UserTicker } from './types';
import { getAuthBackend, getD1Binding } from './users';
import { type D1DatabaseLike, type D1ResultLike, isUniqueConstraintError } from './users.d1';

export const TICKERS_PREFIX = 'user:tickers:';

export class TickerAlreadyExistsError extends Error {
  constructor(symbol: string) {
    super(`Ticker ${symbol} is already in the watchlist`);
    this.name = 'TickerAlreadyExistsError';
  }
}

export class TickerNotFoundError extends Error {
  constructor(id: string) {
    super(`Ticker ${id} was not found`);
    this.name = 'TickerNotFoundError';
  }
}

export interface WatchlistEntry {
  userId: string;
  tickers: UserTicker[];
}

export interface WatchlistRepository {
  list(userId: string): Promise<UserTicker[]>;
  find(userId: string, tickerId: string): Promise<UserTicker | null>;
  add(userId: string, ticker: UserTicker): Promise<void>;
  addMany(userId: string, tickers: UserTicker[]): Promise<number>;
  update(userId: string, ticker: UserTicker): Promise<void>;
  remove(userId: string, tickerId: string): Promise<boolean>;
  reorder(userId: string, orderedIds: string[]): Promise<UserTicker[]>;
  replaceAll(userId: string, tickers: UserTicker[]): Promise<void>;
  deleteAll(userId: string): Promise<void>;
  /** Watchlists that may contain armed alerts, for the scheduled scan. */
  listAllForScan(): Promise<WatchlistEntry[]>;
  /** Every stored ticker, grouped by user. Used by the migration verifier. */
  listAll(): Promise<WatchlistEntry[]>;
  /** Idempotent import used by the backfill and the lazy transition read. */
  importMany(userId: string, tickers: UserTicker[]): Promise<{ imported: number; skipped: number }>;
  /** Whether the user's KV watchlist has already been imported into D1. */
  isMigrated(userId: string): Promise<boolean>;
  markMigrated(userId: string): Promise<void>;
}

/** Normalise optional fields so KV and D1 payloads compare and serialise alike. */
export function normalizeTicker(ticker: UserTicker): UserTicker {
  return {
    id: ticker.id,
    symbol: ticker.symbol.toUpperCase(),
    name: ticker.name,
    trackingValue: ticker.trackingValue ?? null,
    trackingCurrency: ticker.trackingCurrency ?? null,
    notes: ticker.notes ?? '',
    order: ticker.order ?? 0,
    createdAt: ticker.createdAt,
    quote: ticker.quote ?? null,
    exchangeTimezone: ticker.exchangeTimezone ?? ticker.quote?.exchangeTimezone ?? null,
    alertHigh: ticker.alertHigh ?? null,
    alertLow: ticker.alertLow ?? null,
    alertCurrency: ticker.alertCurrency ?? null,
    alertHighSource: ticker.alertHighSource,
    alertLowSource: ticker.alertLowSource,
    alertSetAt: ticker.alertSetAt,
  };
}

/** JSON with sorted object keys, for exact comparisons independent of order. */
function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = stableValue(source[key]);
    }
    return sorted;
  }
  return value;
}

export function stableTickerJson(ticker: UserTicker): string {
  return JSON.stringify(stableValue(normalizeTicker(ticker)));
}

export function tickersEquivalent(a: UserTicker, b: UserTicker): boolean {
  return stableTickerJson(a) === stableTickerJson(b);
}

export function hasAlertThreshold(ticker: UserTicker): boolean {
  return (
    (typeof ticker.alertHigh === 'number' && ticker.alertHigh > 0) ||
    (typeof ticker.alertLow === 'number' && ticker.alertLow > 0)
  );
}

function sortTickers(tickers: UserTicker[]): UserTicker[] {
  return [...tickers].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

function nextOrder(tickers: UserTicker[]): number {
  return tickers.reduce((max, ticker) => Math.max(max, (ticker.order ?? -1) + 1), 0);
}

export function nextTickerOrder(tickers: UserTicker[]): number {
  return nextOrder(tickers);
}

function reorderList(tickers: UserTicker[], orderedIds: string[]): UserTicker[] {
  const remaining = new Map(tickers.map((ticker) => [ticker.id, ticker]));
  const reordered: UserTicker[] = [];

  for (const id of orderedIds) {
    const ticker = remaining.get(id);
    if (!ticker) continue;
    ticker.order = reordered.length;
    reordered.push(ticker);
    remaining.delete(id);
  }

  for (const ticker of remaining.values()) {
    ticker.order = reordered.length;
    reordered.push(ticker);
  }

  return reordered;
}

function kvKey(userId: string): string {
  return `${TICKERS_PREFIX}${userId}`;
}

export class KvWatchlistRepository implements WatchlistRepository {
  async list(userId: string): Promise<UserTicker[]> {
    return sortTickers((await kvGet<UserTicker[]>(kvKey(userId))) ?? []);
  }

  async find(userId: string, tickerId: string): Promise<UserTicker | null> {
    return (await this.list(userId)).find((ticker) => ticker.id === tickerId) ?? null;
  }

  async add(userId: string, ticker: UserTicker): Promise<void> {
    const tickers = await this.list(userId);
    if (tickers.some((item) => item.symbol.toUpperCase() === ticker.symbol.toUpperCase())) {
      throw new TickerAlreadyExistsError(ticker.symbol);
    }
    await this.replaceAll(userId, [...tickers, ticker]);
  }

  async addMany(userId: string, tickers: UserTicker[]): Promise<number> {
    const existing = await this.list(userId);
    const symbols = new Set(existing.map((ticker) => ticker.symbol.toUpperCase()));
    const added = tickers.filter((ticker) => !symbols.has(ticker.symbol.toUpperCase()));

    if (added.length > 0) await this.replaceAll(userId, [...existing, ...added]);
    return added.length;
  }

  async update(userId: string, ticker: UserTicker): Promise<void> {
    const tickers = await this.list(userId);
    const index = tickers.findIndex((item) => item.id === ticker.id);
    if (index === -1) throw new TickerNotFoundError(ticker.id);

    tickers[index] = ticker;
    await this.replaceAll(userId, tickers);
  }

  async remove(userId: string, tickerId: string): Promise<boolean> {
    const tickers = await this.list(userId);
    const next = tickers.filter((ticker) => ticker.id !== tickerId);
    if (next.length === tickers.length) return false;

    await this.replaceAll(userId, next);
    return true;
  }

  async reorder(userId: string, orderedIds: string[]): Promise<UserTicker[]> {
    const reordered = reorderList(await this.list(userId), orderedIds);
    await this.replaceAll(userId, reordered);
    return reordered;
  }

  async replaceAll(userId: string, tickers: UserTicker[]): Promise<void> {
    if (tickers.length === 0) {
      await kvDelete(kvKey(userId));
      return;
    }
    await kvPut(kvKey(userId), sortTickers(tickers));
  }

  async deleteAll(userId: string): Promise<void> {
    await kvDelete(kvKey(userId));
  }

  async listAllForScan(): Promise<WatchlistEntry[]> {
    const entries = await this.listAll();
    return entries
      .map((entry) => ({ ...entry, tickers: entry.tickers.filter(hasAlertThreshold) }))
      .filter((entry) => entry.tickers.length > 0);
  }

  async listAll(): Promise<WatchlistEntry[]> {
    const keys = await kvListAll(TICKERS_PREFIX);
    const entries: WatchlistEntry[] = [];

    for (const key of keys) {
      const tickers = (await kvGet<UserTicker[]>(key)) ?? [];
      if (tickers.length > 0) {
        entries.push({ userId: key.slice(TICKERS_PREFIX.length), tickers });
      }
    }

    return entries;
  }

  async importMany(userId: string, tickers: UserTicker[]): Promise<{ imported: number; skipped: number }> {
    const existing = await this.list(userId);
    const ids = new Set(existing.map((ticker) => ticker.id));
    const symbols = new Set(existing.map((ticker) => ticker.symbol.toUpperCase()));
    const imported = tickers.filter(
      (ticker) => !ids.has(ticker.id) && !symbols.has(ticker.symbol.toUpperCase())
    );

    if (imported.length > 0) await this.replaceAll(userId, [...existing, ...imported]);
    return { imported: imported.length, skipped: tickers.length - imported.length };
  }

  async isMigrated(): Promise<boolean> {
    // A pure KV deployment has nothing to migrate; the marker only exists to
    // distinguish "empty in D1" from "not imported yet" in dual mode.
    return true;
  }

  async markMigrated(): Promise<void> {
    // No-op for the legacy backend.
  }
}

const TICKER_COLUMNS = `
  id, user_id, symbol, name, tracking_value, tracking_currency, notes, position,
  alert_high, alert_low, alert_currency, alert_high_source, alert_low_source,
  alert_set_at, exchange_timezone, quote_json, created_at
`;

const INSERT_TICKER = `
  INSERT INTO tickers (${TICKER_COLUMNS})
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const INSERT_TICKER_IF_ABSENT = `
  INSERT OR IGNORE INTO tickers (${TICKER_COLUMNS})
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const UPDATE_TICKER = `
  UPDATE tickers SET
    symbol = ?, name = ?, tracking_value = ?, tracking_currency = ?, notes = ?,
    position = ?, alert_high = ?, alert_low = ?, alert_currency = ?,
    alert_high_source = ?, alert_low_source = ?, alert_set_at = ?,
    exchange_timezone = ?, quote_json = ?, created_at = ?
  WHERE id = ? AND user_id = ?
`;

function toTicker(row: any): UserTicker {
  let quote: UserTicker['quote'] = null;
  if (row.quote_json) {
    try {
      quote = JSON.parse(String(row.quote_json));
    } catch {
      quote = null;
    }
  }

  return {
    id: String(row.id),
    symbol: String(row.symbol),
    name: String(row.name),
    trackingValue: row.tracking_value ?? null,
    trackingCurrency: row.tracking_currency ?? null,
    notes: row.notes ?? '',
    order: Number(row.position),
    createdAt: Number(row.created_at),
    quote,
    exchangeTimezone: row.exchange_timezone ?? null,
    alertHigh: row.alert_high ?? null,
    alertLow: row.alert_low ?? null,
    alertCurrency: row.alert_currency ?? null,
    alertHighSource: row.alert_high_source ?? undefined,
    alertLowSource: row.alert_low_source ?? undefined,
    alertSetAt: row.alert_set_at ?? undefined,
  };
}

function insertValues(userId: string, ticker: UserTicker): unknown[] {
  const normalized = normalizeTicker(ticker);
  return [
    normalized.id,
    userId,
    normalized.symbol,
    normalized.name,
    normalized.trackingValue ?? null,
    normalized.trackingCurrency ?? null,
    normalized.notes ?? '',
    normalized.order ?? 0,
    normalized.alertHigh ?? null,
    normalized.alertLow ?? null,
    normalized.alertCurrency ?? null,
    normalized.alertHighSource ?? null,
    normalized.alertLowSource ?? null,
    normalized.alertSetAt ?? null,
    normalized.exchangeTimezone ?? null,
    normalized.quote ? JSON.stringify(normalized.quote) : null,
    normalized.createdAt,
  ];
}

function updateValues(userId: string, ticker: UserTicker): unknown[] {
  const normalized = normalizeTicker(ticker);
  return [
    normalized.symbol,
    normalized.name,
    normalized.trackingValue ?? null,
    normalized.trackingCurrency ?? null,
    normalized.notes ?? '',
    normalized.order ?? 0,
    normalized.alertHigh ?? null,
    normalized.alertLow ?? null,
    normalized.alertCurrency ?? null,
    normalized.alertHighSource ?? null,
    normalized.alertLowSource ?? null,
    normalized.alertSetAt ?? null,
    normalized.exchangeTimezone ?? null,
    normalized.quote ? JSON.stringify(normalized.quote) : null,
    normalized.createdAt,
    normalized.id,
    userId,
  ];
}

export class D1WatchlistRepository implements WatchlistRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  async list(userId: string): Promise<UserTicker[]> {
    const { results } = await this.db
      .prepare(`SELECT ${TICKER_COLUMNS} FROM tickers WHERE user_id = ? ORDER BY position ASC, created_at ASC`)
      .bind(userId)
      .all<any>();
    return results.map(toTicker);
  }

  async find(userId: string, tickerId: string): Promise<UserTicker | null> {
    const row = await this.db
      .prepare(`SELECT ${TICKER_COLUMNS} FROM tickers WHERE id = ? AND user_id = ? LIMIT 1`)
      .bind(tickerId, userId)
      .first<any>();
    return row ? toTicker(row) : null;
  }

  async add(userId: string, ticker: UserTicker): Promise<void> {
    try {
      await this.db.prepare(INSERT_TICKER).bind(...insertValues(userId, ticker)).run();
    } catch (err) {
      if (isUniqueConstraintError(err)) throw new TickerAlreadyExistsError(ticker.symbol);
      throw err;
    }
  }

  async addMany(userId: string, tickers: UserTicker[]): Promise<number> {
    if (tickers.length === 0) return 0;

    const statements = tickers.map((ticker) =>
      this.db.prepare(INSERT_TICKER_IF_ABSENT).bind(...insertValues(userId, ticker))
    );
    const results = (await this.db.batch(statements)) as D1ResultLike[];
    return results.reduce((sum, result) => sum + (result.meta?.changes ?? 0), 0);
  }

  async update(userId: string, ticker: UserTicker): Promise<void> {
    const result = await this.db
      .prepare(UPDATE_TICKER)
      .bind(...updateValues(userId, ticker))
      .run();
    if ((result.meta?.changes ?? 0) === 0) throw new TickerNotFoundError(ticker.id);
  }

  async remove(userId: string, tickerId: string): Promise<boolean> {
    const result = await this.db
      .prepare('DELETE FROM tickers WHERE id = ? AND user_id = ?')
      .bind(tickerId, userId)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  async reorder(userId: string, orderedIds: string[]): Promise<UserTicker[]> {
    const tickers = await this.list(userId);
    const reordered = reorderList(tickers, orderedIds);

    const statements = reordered
      .map((ticker, position) =>
        this.db
          .prepare('UPDATE tickers SET position = ? WHERE id = ? AND user_id = ?')
          .bind(position, ticker.id, userId)
      );

    if (statements.length > 0) await this.db.batch(statements);
    return this.list(userId);
  }

  async replaceAll(userId: string, tickers: UserTicker[]): Promise<void> {
    const statements = [this.db.prepare('DELETE FROM tickers WHERE user_id = ?').bind(userId)];
    for (const ticker of tickers) {
      statements.push(this.db.prepare(INSERT_TICKER).bind(...insertValues(userId, ticker)));
    }
    await this.db.batch(statements);
  }

  async deleteAll(userId: string): Promise<void> {
    await this.db.prepare('DELETE FROM tickers WHERE user_id = ?').bind(userId).run();
  }

  async listAllForScan(): Promise<WatchlistEntry[]> {
    const { results } = await this.db
      .prepare(
        `SELECT ${TICKER_COLUMNS} FROM tickers
         WHERE (alert_high IS NOT NULL OR alert_low IS NOT NULL)
         ORDER BY user_id ASC, position ASC`
      )
      .all<any>();

    const byUser = new Map<string, UserTicker[]>();
    for (const row of results) {
      const userId = String(row.user_id);
      const list = byUser.get(userId);
      const ticker = toTicker(row);
      if (list) list.push(ticker);
      else byUser.set(userId, [ticker]);
    }

    return Array.from(byUser, ([userId, tickers]) => ({ userId, tickers }));
  }

  async listAll(): Promise<WatchlistEntry[]> {
    const { results } = await this.db
      .prepare(`SELECT ${TICKER_COLUMNS} FROM tickers ORDER BY user_id ASC, position ASC`)
      .all<any>();

    const byUser = new Map<string, UserTicker[]>();
    for (const row of results) {
      const userId = String(row.user_id);
      const list = byUser.get(userId);
      const ticker = toTicker(row);
      if (list) list.push(ticker);
      else byUser.set(userId, [ticker]);
    }

    return Array.from(byUser, ([userId, tickers]) => ({ userId, tickers }));
  }

  async importMany(userId: string, tickers: UserTicker[]): Promise<{ imported: number; skipped: number }> {
    if (tickers.length === 0) return { imported: 0, skipped: 0 };

    const statements = tickers.map((ticker) =>
      this.db.prepare(INSERT_TICKER_IF_ABSENT).bind(...insertValues(userId, ticker))
    );
    const results = (await this.db.batch(statements)) as D1ResultLike[];
    const imported = results.reduce((sum, result) => sum + (result.meta?.changes ?? 0), 0);
    return { imported, skipped: tickers.length - imported };
  }

  async isMigrated(userId: string): Promise<boolean> {
    const row = await this.db
      .prepare('SELECT 1 AS migrated FROM ticker_migrations WHERE user_id = ? LIMIT 1')
      .bind(userId)
      .first<{ migrated: number }>();
    return !!row;
  }

  async markMigrated(userId: string): Promise<void> {
    await this.db
      .prepare('INSERT OR IGNORE INTO ticker_migrations (user_id, migrated_at) VALUES (?, ?)')
      .bind(userId, Date.now())
      .run();
  }
}

export class DualWatchlistRepository implements WatchlistRepository {
  constructor(
    private readonly primary: WatchlistRepository,
    private readonly legacy: WatchlistRepository
  ) {}

  private async mirror(userId: string): Promise<void> {
    try {
      const tickers = await this.primary.list(userId);
      await this.legacy.replaceAll(userId, tickers);
    } catch (err) {
      // D1 is the source of truth; a KV mirror failure must not fail the write.
      console.warn('KV watchlist mirror failed during dual-write:', err);
    }
  }

  async list(userId: string): Promise<UserTicker[]> {
    const primary = await this.primary.list(userId);
    if (primary.length > 0) return primary;

    // An imported-but-empty list means the user really has no tickers; do not
    // resurrect stale KV data after a delete.
    if (await this.primary.isMigrated(userId)) return [];

    const legacy = await this.legacy.list(userId);
    if (legacy.length === 0) {
      try {
        await this.primary.markMigrated(userId);
      } catch (err) {
        console.warn('D1 watchlist migration marker failed:', err);
      }
      return [];
    }

    try {
      await this.primary.importMany(userId, legacy);
      await this.primary.markMigrated(userId);
    } catch (err) {
      // Keep serving the KV list; the explicit backfill can retry later.
      console.warn('D1 lazy watchlist import failed:', err);
    }
    return legacy;
  }

  async find(userId: string, tickerId: string): Promise<UserTicker | null> {
    const primary = await this.primary.find(userId, tickerId);
    if (primary) return primary;
    if (await this.primary.isMigrated(userId)) return null;

    // Import the whole KV list, not just the matching row: marking the user as
    // migrated after a partial import would hide the other tickers forever.
    const legacy = await this.legacy.list(userId);
    const found = legacy.find((ticker) => ticker.id === tickerId) ?? null;
    if (legacy.length > 0) {
      try {
        await this.primary.importMany(userId, legacy);
        await this.primary.markMigrated(userId);
      } catch (err) {
        console.warn('D1 lazy watchlist import failed:', err);
      }
    }
    return found;
  }

  async add(userId: string, ticker: UserTicker): Promise<void> {
    await this.list(userId);
    await this.primary.add(userId, ticker);
    await this.mirror(userId);
  }

  async addMany(userId: string, tickers: UserTicker[]): Promise<number> {
    await this.list(userId);
    const imported = await this.primary.addMany(userId, tickers);
    await this.mirror(userId);
    return imported;
  }

  async update(userId: string, ticker: UserTicker): Promise<void> {
    await this.list(userId);
    await this.primary.update(userId, ticker);
    await this.mirror(userId);
  }

  async remove(userId: string, tickerId: string): Promise<boolean> {
    await this.list(userId);
    const removed = await this.primary.remove(userId, tickerId);
    await this.mirror(userId);
    return removed;
  }

  async reorder(userId: string, orderedIds: string[]): Promise<UserTicker[]> {
    await this.list(userId);
    const tickers = await this.primary.reorder(userId, orderedIds);
    await this.mirror(userId);
    return tickers;
  }

  async replaceAll(userId: string, tickers: UserTicker[]): Promise<void> {
    await this.primary.replaceAll(userId, tickers);
    await this.mirror(userId);
  }

  async deleteAll(userId: string): Promise<void> {
    await this.primary.deleteAll(userId);
    await this.mirror(userId);
  }

  async listAllForScan(): Promise<WatchlistEntry[]> {
    const primary = await this.primary.listAllForScan();
    const merged = new Map(primary.map((entry) => [entry.userId, entry]));

    for (const entry of await this.legacy.listAllForScan()) {
      if (merged.has(entry.userId)) continue;
      if (await this.primary.isMigrated(entry.userId)) continue;

      try {
        await this.primary.importMany(entry.userId, entry.tickers);
        await this.primary.markMigrated(entry.userId);
      } catch (err) {
        // Still scan the KV copy this run rather than silently missing alerts.
        console.warn('D1 lazy watchlist import failed during scan:', err);
      }
      merged.set(entry.userId, entry);
    }

    return Array.from(merged.values());
  }

  async listAll(): Promise<WatchlistEntry[]> {
    // The verifier always targets D1 directly; the scan uses the merged view.
    return this.primary.listAll();
  }

  async importMany(userId: string, tickers: UserTicker[]): Promise<{ imported: number; skipped: number }> {
    return this.primary.importMany(userId, tickers);
  }

  async isMigrated(userId: string): Promise<boolean> {
    return this.primary.isMigrated(userId);
  }

  async markMigrated(userId: string): Promise<void> {
    return this.primary.markMigrated(userId);
  }
}

/**
 * Resolve the watchlist backend for the current invocation.
 *
 * When auth still runs on KV, watchlists must stay on KV too: D1 tickers carry
 * a foreign key to `users(id)` and the account has no D1 row yet.
 */
export function getWatchlistRepository(): WatchlistRepository {
  const db = getD1Binding();
  if (!db) return new KvWatchlistRepository();

  const configured = getEnvVar('TICKER_BACKEND');
  if (configured === 'kv') return new KvWatchlistRepository();
  if (getAuthBackend(db) === 'kv') return new KvWatchlistRepository();

  const primary = new D1WatchlistRepository(db);
  if (configured === 'd1') return primary;
  return new DualWatchlistRepository(primary, new KvWatchlistRepository());
}

/** D1-only repository, used by the backfill route. */
export function getD1WatchlistRepository(): D1WatchlistRepository | null {
  const db = getD1Binding();
  return db ? new D1WatchlistRepository(db) : null;
}
