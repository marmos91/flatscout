import type { Command } from 'commander';
import { migrate, openDb } from '@flatscout/db';
import { resolvePaths } from '../paths.js';

/** Registers the `flatscout migrate` subcommand: applies any pending SQL migrations to the configured DB. */
export function registerMigrate(prog: Command): void {
  prog
    .command('migrate')
    .description('Apply pending database migrations')
    .action(async () => {
      const globalOpts = prog.opts<{ config?: string; dataDir?: string }>();
      const paths = resolvePaths({ config: globalOpts.config, dataDir: globalOpts.dataDir });
      const db = openDb(paths.dbFile);
      const r = migrate(db);
      console.log(`applied ${r.applied.length} migration(s): ${r.applied.join(', ') || '(none)'}`);
    });
}
