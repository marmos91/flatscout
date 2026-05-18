import { Command } from 'commander';
import { openDb } from '@wabe/db';
import { resolvePaths } from '../paths.js';

interface Row {
  id: string;
  source: string;
  url: string;
  first_seen_at: number;
  payload: string;
  final: number | null;
}

export function registerList(prog: Command): void {
  prog
    .command('list')
    .description('List persisted listings (newest first) with their latest score')
    .option('--limit <n>', 'max rows', (v) => Number.parseInt(v, 10), 20)
    .option('--source <name>')
    .option('--min-score <n>', '0..100', (v) => Number.parseInt(v, 10))
    .option('--since <iso>', 'ISO date filter')
    .option('--json', 'raw JSON output')
    .action(
      async (opts: { limit: number; source?: string; minScore?: number; since?: string; json?: boolean }) => {
        const globalOpts = prog.opts<{ config?: string; dataDir?: string }>();
        const paths = resolvePaths({ config: globalOpts.config, dataDir: globalOpts.dataDir });
        const db = openDb(paths.dbFile);
        const where: string[] = [];
        const params: Array<string | number> = [];
        if (opts.source) {
          where.push('l.source = ?');
          params.push(opts.source);
        }
        if (opts.minScore != null) {
          where.push('s.final >= ?');
          params.push(opts.minScore);
        }
        if (opts.since) {
          where.push('l.first_seen_at >= ?');
          params.push(new Date(opts.since).getTime());
        }
        const sql = `
SELECT l.id, l.source, l.url, l.first_seen_at, l.payload, s.final
FROM listings l
LEFT JOIN (
  SELECT listing_id, final FROM scores s1
  WHERE scored_at = (SELECT MAX(scored_at) FROM scores s2 WHERE s2.listing_id = s1.listing_id)
) s ON s.listing_id = l.id
${where.length ? `WHERE ${where.join(' AND ')}` : ''}
ORDER BY l.first_seen_at DESC
LIMIT ${opts.limit}`;
        const rows = db._raw.prepare<typeof params, Row>(sql).all(...params);
        if (opts.json) {
          console.log(JSON.stringify(rows.map(({ payload, ...rest }) => ({ ...rest, listing: JSON.parse(payload) })), null, 2));
          return;
        }
        const headers = ['SCORE', 'SOURCE', 'ID', 'URL', 'SEEN'];
        console.log(headers.join('\t'));
        for (const r of rows) {
          console.log(
            [r.final ?? '-', r.source, r.id, r.url, new Date(r.first_seen_at).toISOString()].join('\t'),
          );
        }
      },
    );
}
