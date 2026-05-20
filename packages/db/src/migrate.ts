import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WabeDb } from './client.js';
import { collapseListings } from './collapse-listings.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/**
 * Applies any `.sql` migration files in `dir` that have not already been
 * recorded in the `_migrations` table.
 *
 * Files are applied in filename sort order, each inside a transaction; the
 * filename is recorded with `applied_at` on success. Returns the filenames
 * applied during this call (empty array if already up to date).
 */
export function migrate(db: WabeDb, dir = MIGRATIONS_DIR): { applied: string[] } {
  const raw = db._raw;
  raw.exec(
    'CREATE TABLE IF NOT EXISTS _migrations (filename TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);',
  );
  const applied = new Set(
    raw
      .prepare<[], { filename: string }>('SELECT filename FROM _migrations')
      .all()
      .map((r) => r.filename),
  );
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const newlyApplied: string[] = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = readFileSync(join(dir, f), 'utf8');
    raw.transaction(() => {
      raw.exec(sql);
      if (f === '0005_collapse_canonical.sql') {
        collapseListings(db);
      }
      raw.prepare('INSERT INTO _migrations (filename, applied_at) VALUES (?, ?)').run(f, Date.now());
    })();
    newlyApplied.push(f);
  }
  return { applied: newlyApplied };
}
