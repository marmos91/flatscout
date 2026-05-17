import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

export type WabeDb = BetterSQLite3Database<typeof schema> & { _raw: Database.Database };

export function openDb(filename: string): WabeDb {
  const sqlite = new Database(filename);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  // NOTE: deviated from plan — cast via `unknown` because drizzle's returned type lacks `_raw`,
  // which TS strict mode rejects as a non-overlapping cast. We assign `_raw` immediately after.
  const db = drizzle(sqlite, { schema }) as unknown as WabeDb;
  db._raw = sqlite;
  return db;
}
