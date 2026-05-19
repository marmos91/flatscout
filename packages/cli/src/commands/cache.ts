import type { Command } from 'commander';
import { migrate, openDb, type WabeDb } from '@wabe/db';
import { resolvePaths } from '../paths.js';

interface ClearOptions {
  commute?: boolean;
}

export function registerCache(prog: Command): void {
  const cache = prog.command('cache').description('Cache utilities');

  cache
    .command('clear')
    .description('Clear cached enricher data')
    .option('--commute', 'clear commute + geocode caches')
    .action((opts: ClearOptions) => {
      if (!opts.commute) {
        console.error('Specify what to clear, e.g. --commute');
        process.exit(2);
      }
      const globalOpts = prog.opts<{ config?: string; dataDir?: string }>();
      const paths = resolvePaths({ config: globalOpts.config, dataDir: globalOpts.dataDir });
      const db = openDb(paths.dbFile);
      migrate(db);

      const counts = readCounts(db);
      if (counts.commute === 0 && counts.geocode === 0) {
        console.log('commute_cache + geocode_cache already empty');
        return;
      }
      truncate(db);
      console.log(
        `cleared commute_cache (${counts.commute} rows) + geocode_cache (${counts.geocode} rows)`,
      );
    });
}

function readCounts(db: WabeDb): { commute: number; geocode: number } {
  const c = db._raw.prepare('SELECT COUNT(*) AS c FROM commute_cache').get() as { c: number };
  const g = db._raw.prepare('SELECT COUNT(*) AS c FROM geocode_cache').get() as { c: number };
  return { commute: c.c, geocode: g.c };
}

function truncate(db: WabeDb): void {
  const tx = db._raw.transaction(() => {
    db._raw.exec('DELETE FROM commute_cache');
    db._raw.exec('DELETE FROM geocode_cache');
  });
  tx();
}
