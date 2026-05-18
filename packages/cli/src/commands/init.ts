import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { Command } from 'commander';
import * as p from '@clack/prompts';
import { resolveExampleDir, resolvePaths } from '../paths.js';
import { openDb } from '@wabe/db';
import { migrate } from '@wabe/db';

const SAMPLE_CONFIG_YAML = `\
enabled:
  sources:
    - {name: flatfox-zurich,   plugin: source-flatfox,    config: plugins/source-flatfox.yaml}
  notifiers:
    - {name: telegram, plugin: notifier-telegram, config: plugins/notifier-telegram.yaml}
log:
  level: info
`;

const SAMPLE_FILTERS_YAML = `\
filters:
  - {kind: field, field: rooms,         op: ">=", value: 3, on_missing: skip}
  - {kind: field, field: price.total,   op: "<=", value: 5000, on_missing: skip}
`;

const SAMPLE_SCORING_YAML = `\
scoring:
  - type: rule
    name: rent_value
    weight: 50
    metric: price.total
    on_missing: zero
    normalize: {type: linear, best: 2000, worst: 4000, invert: true}
  - type: rule
    name: size
    weight: 30
    metric: area_m2
    on_missing: zero
    normalize: {type: linear, best: 120, worst: 60, invert: false}
  - type: rule
    name: rooms_score
    weight: 20
    metric: rooms
    on_missing: zero
    normalize: {type: linear, best: 4.5, worst: 2.5, invert: false}
notify:
  threshold: 70
  daily_quota: 5
`;

function flatfoxSample(priceMax: number, roomsMin: number) {
  return `\
schedule: '*/5 * * * *'
search:
  cities: [Zürich]
  price_max: ${priceMax}
  rooms_min: ${roomsMin}
  surface_min: 60
  offer_type: RENT
  category: APARTMENT
fetch:
  page_size: 100
  max_pages: 3
  pace_ms: 2000
`;
}

const telegramSample = `\
bot_token: '\${env.TELEGRAM_BOT_TOKEN}'
chat_id:   '\${env.TELEGRAM_CHAT_ID}'
format: compact
`;

const ENV_SKELETON = `\
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
`;

function rentalTermSample(opts: {
  mode: 'long' | 'short';
  excludeUnknown: boolean;
  stayFrom?: string;
  stayTo?: string;
  minMonths?: string;
  maxMonths?: string;
}): string {
  const lines: string[] = ['rental_term:', `  mode: ${opts.mode}`];
  if (opts.mode === 'long') {
    lines.push(`  exclude_unknown: ${opts.excludeUnknown}`);
  }
  const stayKeys = [
    ['from', opts.stayFrom],
    ['to', opts.stayTo],
    ['min_months', opts.minMonths],
    ['max_months', opts.maxMonths],
  ] as const;
  const stayEntries = stayKeys.filter(([, v]) => v && v.length > 0);
  if (opts.mode === 'short' && stayEntries.length > 0) {
    lines.push('  stay:');
    for (const [k, v] of stayEntries) lines.push(`    ${k}: ${v}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Registers the `wabe init` subcommand: interactively prompts the user for
 * Telegram credentials and search parameters, then writes a starter set of
 * config files, a `.env`, and runs initial DB migrations.
 *
 * With `--example <name>`, skips prompts and copies the bundled example config
 * tree (e.g. `examples/zurich-family/config/`) into the resolved config dir.
 * Existing files are preserved unless `--force` is set.
 */
export function registerInit(prog: Command): void {
  prog
    .command('init')
    .description('Interactive setup, or `--example <name>` for non-interactive bootstrap')
    .option('--example <name>', 'copy a bundled example config tree (skips prompts)')
    .option('--example-dir <path>', 'absolute path to an example config dir (overrides resolver)')
    .option('--force', 'overwrite existing files', false)
    .action(async (opts: { example?: string; exampleDir?: string; force?: boolean }) => {
      const globalOpts = prog.opts<{ config?: string; dataDir?: string }>();
      const paths = resolvePaths({ config: globalOpts.config, dataDir: globalOpts.dataDir });
      const force = opts.force ?? false;

      if (opts.example || opts.exampleDir) {
        const sourceDir = opts.exampleDir ?? resolveExampleDir(opts.example as string);
        p.intro(`wabe init --example ${opts.example ?? '(custom)'}`);
        const stats = copyTreeRecursive(sourceDir, paths.configDir, force);
        const envPath = join(process.cwd(), '.env');
        const envWritten = writeEnvIfAbsent(envPath, ENV_SKELETON);
        const db = openDb(paths.dbFile);
        const m = migrate(db);
        const skippedNote =
          stats.skipped.length > 0
            ? `\nskipped (already exist, use --force):\n  - ${stats.skipped.join('\n  - ')}`
            : '';
        const envNote = envWritten ? '.env: created skeleton' : '.env: preserved (already present)';
        p.note(
          `source: ${sourceDir}\nconfig: ${paths.configDir}\ndata:   ${paths.dataDir}\nfiles written: ${stats.written.length}\n${envNote}\nmigrations applied: ${m.applied.length}${skippedNote}`,
        );
        p.outro(
          'done — fill in .env (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID), then run `wabe doctor` and `wabe scan`.',
        );
        return;
      }

      p.intro('wabe init');

      const tgToken = await p.text({ message: 'Telegram bot token (from @BotFather):' });
      if (p.isCancel(tgToken)) return p.cancel('aborted');
      const tgChat = await p.text({ message: 'Telegram chat id (numeric, e.g. 123456789):' });
      if (p.isCancel(tgChat)) return p.cancel('aborted');
      const priceMax = await p.text({ message: 'Max monthly rent CHF', placeholder: '4000' });
      if (p.isCancel(priceMax)) return p.cancel('aborted');
      const roomsMin = await p.text({ message: 'Min rooms', placeholder: '3.5' });
      if (p.isCancel(roomsMin)) return p.cancel('aborted');

      const rentalMode = (await p.select({
        message: 'Rental term preference?',
        options: [
          { label: 'Long-term only (default)', value: 'long' as const },
          { label: 'Short-term only', value: 'short' as const },
        ],
      })) as 'long' | 'short' | symbol;
      if (p.isCancel(rentalMode)) return p.cancel('aborted');

      let stayFrom = '';
      let stayTo = '';
      let minMonths = '';
      let maxMonths = '';
      if (rentalMode === 'short') {
        const r1 = await p.text({
          message: 'Stay from (ISO date, optional)',
          placeholder: '2026-06-01',
          defaultValue: '',
        });
        if (p.isCancel(r1)) return p.cancel('aborted');
        stayFrom = String(r1);
        const r2 = await p.text({
          message: 'Stay to (ISO date, optional)',
          placeholder: '2026-08-31',
          defaultValue: '',
        });
        if (p.isCancel(r2)) return p.cancel('aborted');
        stayTo = String(r2);
        const r3 = await p.text({
          message: 'Min stay length in months (optional)',
          placeholder: '1',
          defaultValue: '',
        });
        if (p.isCancel(r3)) return p.cancel('aborted');
        minMonths = String(r3);
        const r4 = await p.text({
          message: 'Max stay length in months (optional)',
          placeholder: '6',
          defaultValue: '',
        });
        if (p.isCancel(r4)) return p.cancel('aborted');
        maxMonths = String(r4);
      }

      writeIfMissing(join(paths.configDir, 'config.yaml'), SAMPLE_CONFIG_YAML, force);
      writeIfMissing(join(paths.configDir, 'filters.yaml'), SAMPLE_FILTERS_YAML, force);
      writeIfMissing(join(paths.configDir, 'scoring.yaml'), SAMPLE_SCORING_YAML, force);
      mkdirSync(join(paths.configDir, 'plugins'), { recursive: true });
      writeIfMissing(
        join(paths.configDir, 'plugins', 'source-flatfox.yaml'),
        flatfoxSample(Number(priceMax), Number(roomsMin)),
        force,
      );
      writeIfMissing(join(paths.configDir, 'plugins', 'notifier-telegram.yaml'), telegramSample, force);
      writeIfMissing(
        join(paths.configDir, 'rental_term.yaml'),
        rentalTermSample({
          mode: rentalMode as 'long' | 'short',
          excludeUnknown: false,
          stayFrom,
          stayTo,
          minMonths,
          maxMonths,
        }),
        force,
      );
      const envPath = join(process.cwd(), '.env');
      const envWritten = writeEnvIfAbsent(
        envPath,
        `TELEGRAM_BOT_TOKEN=${tgToken}\nTELEGRAM_CHAT_ID=${tgChat}\n`,
      );
      const db = openDb(paths.dbFile);
      const m = migrate(db);
      const envNote = envWritten
        ? '.env: written with your Telegram credentials'
        : `.env: preserved (already present) — your typed credentials were NOT applied; edit ${envPath} manually if needed`;
      p.note(
        `config: ${paths.configDir}\ndata:   ${paths.dataDir}\n${envNote}\nmigrations applied: ${m.applied.length}`,
      );
      p.outro('done — run `wabe doctor` to verify, then `wabe scan`.');
    });
}

function writeIfMissing(file: string, content: string, force = false): void {
  if (existsSync(file) && !force) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/**
 * Writes a file only when it does not already exist. Unlike `writeIfMissing`,
 * `--force` is intentionally NOT honored here — used for `.env` so user-entered
 * secrets are never clobbered by a re-run of `wabe init`.
 *
 * @returns true if the file was newly written, false if an existing one was preserved.
 */
function writeEnvIfAbsent(file: string, content: string): boolean {
  if (existsSync(file)) return false;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return true;
}

interface CopyStats {
  written: string[];
  skipped: string[];
}

function copyTreeRecursive(srcDir: string, destDir: string, force: boolean): CopyStats {
  const stats: CopyStats = { written: [], skipped: [] };
  if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) {
    throw new Error(`Example source dir not found or not a directory: ${srcDir}`);
  }
  mkdirSync(destDir, { recursive: true });
  walk(srcDir, srcDir, destDir, force, stats);
  return stats;
}

function walk(rootSrc: string, curSrc: string, rootDest: string, force: boolean, stats: CopyStats): void {
  for (const entry of readdirSync(curSrc, { withFileTypes: true })) {
    const absSrc = join(curSrc, entry.name);
    const rel = relative(rootSrc, absSrc);
    const absDest = join(rootDest, rel);
    if (entry.isDirectory()) {
      mkdirSync(absDest, { recursive: true });
      walk(rootSrc, absSrc, rootDest, force, stats);
    } else if (entry.isFile()) {
      if (existsSync(absDest) && !force) {
        stats.skipped.push(rel);
        continue;
      }
      mkdirSync(dirname(absDest), { recursive: true });
      writeFileSync(absDest, readFileSync(absSrc));
      stats.written.push(rel);
    }
  }
}
