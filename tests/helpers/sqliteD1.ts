// Minimal D1 adapter over Node's built-in SQLite, for repository tests.
//
// The production D1 API is async; node:sqlite is synchronous. This helper keeps
// the same statement shape so the D1 repository code is exercised against real
// SQL and constraints instead of a hand-written mock.

import type {
  D1DatabaseLike,
  D1ResultLike,
  D1StatementLike,
} from '../../src/lib/users.d1';

interface SqliteStatement {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): any;
  all(...params: unknown[]): any[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

// node:sqlite is not typed by the project's @types/node version.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (path: string) => SqliteDatabase;
};

export function createSqliteDatabase(): SqliteDatabase {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

export class SqliteD1 implements D1DatabaseLike {
  constructor(private readonly db: SqliteDatabase) {}

  prepare(sql: string): D1StatementLike {
    const db = this.db;
    let values: unknown[] = [];

    const statement: D1StatementLike = {
      bind(...next: unknown[]) {
        values = next;
        return statement;
      },
      async first<T = unknown>(): Promise<T | null> {
        return (db.prepare(sql).get(...values) ?? null) as T | null;
      },
      async run(): Promise<D1ResultLike> {
        const result = db.prepare(sql).run(...values);
        return { meta: { changes: result.changes } };
      },
      async all<T = unknown>(): Promise<{ results: T[] }> {
        return { results: db.prepare(sql).all(...values) as T[] };
      },
    };

    return statement;
  }

  async batch(statements: D1StatementLike[]): Promise<unknown> {
    const results: D1ResultLike[] = [];
    for (const statement of statements) {
      results.push(await statement.run());
    }
    return results;
  }
}
