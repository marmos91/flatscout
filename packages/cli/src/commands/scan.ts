import type { Command } from 'commander';
import { CircuitBreaker, Quota, createLogger, loadConfig, loadPlugins, runOnce } from '@wabe/server';
import { migrate, openDb } from '@wabe/db';
import { resolvePaths } from '../paths.js';

/**
 * Registers the `wabe scan` subcommand: runs the pipeline once and exits.
 *
 * Supports `--source` to restrict to specific source names and `--dry-run` to
 * disable notifier dispatch (everything else still runs and persists).
 */
export function registerScan(prog: Command): void {
  prog
    .command('scan')
    .description('Run the pipeline once and exit')
    .option('--source <name>', 'override enabled sources (comma-separated)')
    .option('--dry-run', 'skip notifier dispatch')
    .action(async (opts: { source?: string; dryRun?: boolean }) => {
      const globalOpts = prog.opts<{ config?: string; dataDir?: string }>();
      const paths = resolvePaths({ config: globalOpts.config, dataDir: globalOpts.dataDir });
      const cfg = await loadConfig(paths.configDir);
      const logger = createLogger(cfg.top.log.level, process.stdout.isTTY);
      const db = openDb(paths.dbFile);
      migrate(db);
      const loaded = await loadPlugins(cfg);
      let sources = loaded.sources;
      if (opts.source) {
        const allow = new Set(opts.source.split(','));
        sources = sources.filter((s) => allow.has(s.name));
      }
      const notifiers = opts.dryRun ? [] : loaded.notifiers;
      const breakers = new Map(
        sources.map((s) => [s.name, new CircuitBreaker({ failuresBeforeOpen: 3, cooldownMs: 600_000 })]),
      );
      const quota = new Quota(db, cfg.scoring.notify.daily_quota);
      const ctrl = new AbortController();
      process.once('SIGINT', () => ctrl.abort());
      await runOnce({ cfg, db, logger, signal: ctrl.signal, sources, notifiers, breakers, quota });
      logger.info('scan complete');
    });
}
