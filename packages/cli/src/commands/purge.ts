import type { Command } from 'commander';
import * as p from '@clack/prompts';
import { migrate, openDb, type FlatscoutDb } from '@flatscout/db';
import { resolvePaths } from '../paths.js';

interface PurgeOptions {
  listings?: boolean;
  scores?: boolean;
  notifications?: boolean;
  quota?: boolean;
  sitemap?: boolean;
  failures?: boolean;
  all?: boolean;
  yes?: boolean;
}

interface TargetSpec {
  flag: keyof PurgeOptions;
  label: string;
  /** Tables to truncate in this single target, in delete-safe order. */
  tables: string[];
}

/**
 * Targets the user can purge. `listings` cascades to scores + notifications
 * because both have `REFERENCES listings(id)` and migrations don't declare
 * `ON DELETE CASCADE` — deleting listings first would otherwise fail FK checks.
 */
const TARGETS: TargetSpec[] = [
  {
    flag: 'listings',
    label: 'listings (+ cascade scores + notifications)',
    tables: ['notifications', 'scores', 'listings'],
  },
  { flag: 'scores', label: 'scores only', tables: ['scores'] },
  { flag: 'notifications', label: 'notifications only', tables: ['notifications'] },
  { flag: 'quota', label: 'quota_log (resets daily Telegram counter)', tables: ['quota_log'] },
  { flag: 'sitemap', label: 'sitemap_state', tables: ['sitemap_state'] },
  { flag: 'failures', label: 'failures log', tables: ['failures'] },
];

/**
 * Registers the `flatscout purge` subcommand: deletes rows from selected tables.
 * Without flags, prompts the user interactively. Always asks for confirmation
 * unless `--yes` is set. Use `--all` to nuke everything (preserves schema).
 */
export function registerPurge(prog: Command): void {
  prog
    .command('purge')
    .description('Delete persisted data from selected tables (schema preserved)')
    .option('--listings', 'delete listings + scores + notifications (cascade)')
    .option('--scores', 'delete scores only')
    .option('--notifications', 'delete notifications only')
    .option('--quota', 'delete quota_log (resets daily Telegram counter)')
    .option('--sitemap', 'delete sitemap_state')
    .option('--failures', 'delete failures log')
    .option('--all', 'delete everything (preserves schema)')
    .option('-y, --yes', 'skip confirmation prompt')
    .action(async (opts: PurgeOptions) => {
      const globalOpts = prog.opts<{ config?: string; dataDir?: string }>();
      const paths = resolvePaths({ config: globalOpts.config, dataDir: globalOpts.dataDir });
      const db = openDb(paths.dbFile);
      migrate(db);

      const selected = await selectTargets(opts);
      if (selected.length === 0) {
        p.cancel('nothing selected');
        return;
      }

      const counts = countRows(db, selected);
      const totalRows = counts.reduce((acc, c) => acc + c.before, 0);
      if (totalRows === 0) {
        p.note('all selected tables already empty.');
        return;
      }

      const summary = counts.map((c) => `  ${c.table}: ${c.before} rows`).join('\n');
      if (!opts.yes) {
        const confirmed = await p.confirm({
          message: `Delete the following?\n${summary}\nThis cannot be undone.`,
          initialValue: false,
        });
        if (p.isCancel(confirmed) || !confirmed) {
          p.cancel('aborted');
          return;
        }
      }

      const tablesToTruncate = uniqueOrdered(selected.flatMap((s) => s.tables));
      truncate(db, tablesToTruncate);

      const after = countRows(db, selected);
      const result = after.map((c) => `  ${c.table}: ${c.before} → 0`).join('\n');
      p.note(result, `purged ${tablesToTruncate.length} table(s)`);
    });
}

async function selectTargets(opts: PurgeOptions): Promise<TargetSpec[]> {
  if (opts.all) return TARGETS;
  const explicit = TARGETS.filter((t) => opts[t.flag]);
  if (explicit.length > 0) return explicit;
  // No flags → interactive multi-select.
  const picks = await p.multiselect({
    message: 'Pick targets to purge (space to toggle, enter to confirm):',
    options: TARGETS.map((t) => ({ value: t.flag, label: t.label })),
    required: false,
  });
  if (p.isCancel(picks)) return [];
  const picked = picks as Array<keyof PurgeOptions>;
  return TARGETS.filter((t) => picked.includes(t.flag));
}

function countRows(db: FlatscoutDb, targets: TargetSpec[]): Array<{ table: string; before: number }> {
  const tables = uniqueOrdered(targets.flatMap((t) => t.tables));
  return tables.map((table) => {
    const row = db._raw.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number };
    return { table, before: row.c };
  });
}

function truncate(db: FlatscoutDb, tables: string[]): void {
  const tx = db._raw.transaction((tbls: string[]) => {
    for (const t of tbls) db._raw.exec(`DELETE FROM ${t}`);
  });
  tx(tables);
}

function uniqueOrdered<T>(items: T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const item of items) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}
