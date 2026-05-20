import type { Command } from 'commander';
import * as p from '@clack/prompts';
import { openDb } from '@wabe/db';
import { resolvePaths } from '../paths.js';

interface RollbackOptions {
  yes?: boolean;
}

/**
 * Registers `wabe db <subcommand>` for database maintenance.
 *
 * `db rollback-collapse` reverses migration 0005 by swapping `listings_legacy`
 * back into `listings`. Refuses if migrations later than 0005 are applied —
 * the schema may have diverged. Removes the 0005 row from `_migrations` so the
 * migrator re-applies the collapse on next start.
 */
export function registerDb(prog: Command): void {
  const db = prog.command('db').description('Database maintenance subcommands');

  db.command('rollback-collapse')
    .description('Reverse migration 0005_collapse_canonical (restores listings_legacy)')
    .option('--yes', 'skip the confirmation prompt')
    .action(async (opts: RollbackOptions) => {
      const globalOpts = prog.opts<{ config?: string; dataDir?: string }>();
      const paths = resolvePaths({ config: globalOpts.config, dataDir: globalOpts.dataDir });
      const conn = openDb(paths.dbFile);

      const hasLegacy = conn._raw
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='listings_legacy'")
        .get();
      if (!hasLegacy) {
        console.error('Error: listings_legacy table is missing — nothing to roll back.');
        process.exit(1);
      }

      const later = conn._raw
        .prepare(
          "SELECT filename FROM _migrations WHERE filename > '0005_collapse_canonical.sql' ORDER BY filename",
        )
        .all() as Array<{ filename: string }>;
      if (later.length > 0) {
        console.error(
          `Error: migrations later than 0005 are applied — rollback aborted:\n  ${later.map((r) => r.filename).join('\n  ')}`,
        );
        process.exit(1);
      }

      if (!opts.yes) {
        const confirmed = await p.confirm({
          message: 'This will replace the current `listings` table with the pre-collapse snapshot. Continue?',
          initialValue: false,
        });
        if (p.isCancel(confirmed) || !confirmed) {
          p.outro('Aborted.');
          return;
        }
      }

      // openDb() enables `PRAGMA foreign_keys = ON`, and after 0005 the
      // dependent tables (`scores`, `notifications`, `failures`) reference
      // `listings(id)`. Dropping `listings` while FKs are on would fail when
      // those tables have rows, and even if it succeeded the surviving rows
      // would point at canonical_keys that don't exist in the rolled-back
      // listings. Disable FK enforcement around the swap, clear dependent
      // tables (their canonical-key listing_ids no longer resolve), and
      // re-enable FKs afterwards.
      conn._raw.pragma('foreign_keys = OFF');
      try {
        conn._raw.transaction(() => {
          conn._raw.exec('DELETE FROM scores');
          conn._raw.exec('DELETE FROM notifications');
          conn._raw.exec('UPDATE failures SET listing_id = NULL WHERE listing_id IS NOT NULL');
          conn._raw.exec('DROP TABLE listings');
          conn._raw.exec('ALTER TABLE listings_legacy RENAME TO listings');
          conn._raw.exec('DELETE FROM listings_fts');
          conn._raw.prepare('DELETE FROM _migrations WHERE filename = ?').run('0005_collapse_canonical.sql');
        })();
      } finally {
        conn._raw.pragma('foreign_keys = ON');
      }

      console.log('Rollback complete. Re-run `wabe migrate` to re-apply the collapse.');
    });
}
