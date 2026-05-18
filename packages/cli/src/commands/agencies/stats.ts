import type { Command } from 'commander';
import { openDb } from '@wabe/db';
import { resolvePaths } from '../../paths.js';

interface Row {
  source: string;
  count: number;
  last: number | null;
}

// NOTE: deviated from plan — plan referenced `resolveDataDir()` from `paths.ts`,
// but that helper does not exist. Use the existing `resolvePaths()` which already
// resolves the data dir via the same XDG / env-var precedence rules as `wabe scan`.
export function registerStats(parent: Command): void {
  parent
    .command('stats')
    .description('show listing counts per agency from the local SQLite store')
    .action(() => {
      const paths = resolvePaths();
      const db = openDb(paths.dbFile);
      const rows = db._raw
        .prepare<[], Row>(
          "SELECT source, COUNT(*) AS count, MAX(last_seen_at) AS last FROM listings WHERE source LIKE 'agency:%' GROUP BY source ORDER BY count DESC",
        )
        .all();
      if (rows.length === 0) {
        console.log('no agency listings yet — run `wabe scan` first.');
        return;
      }
      for (const r of rows) {
        const lastSeen = r.last ? new Date(r.last).toISOString() : 'never';
        console.log(`${r.source.padEnd(40)} ${String(r.count).padStart(6)}  last seen ${lastSeen}`);
      }
    });
}
