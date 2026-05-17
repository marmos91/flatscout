import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WabeDb } from './client.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export function migrate(db: WabeDb, dir = MIGRATIONS_DIR): { applied: string[] } {
  const raw = db._raw;
  raw.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (filename TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);`,
  );
  const applied = new Set(
    raw.prepare<[], { filename: string }>(`SELECT filename FROM _migrations`).all().map((r) => r.filename),
  );
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const newlyApplied: string[] = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = readFileSync(join(dir, f), 'utf8');
    raw.transaction(() => {
      raw.exec(sql);
      raw.prepare(`INSERT INTO _migrations (filename, applied_at) VALUES (?, ?)`).run(f, Date.now());
    })();
    newlyApplied.push(f);
  }
  return { applied: newlyApplied };
}
