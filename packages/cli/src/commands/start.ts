import type { Command } from 'commander';
import {
  type BridgeServer,
  CircuitBreaker,
  Quota,
  createLogger,
  disposeSources,
  loadConfig,
  loadPlugins,
  runDiscoveryCycle,
  runOnce,
  scheduleSources,
  startBridgeServer,
  startHeartbeat,
} from '@wabe/server';
import { migrate, openDb } from '@wabe/db';
import { resolvePaths } from '../paths.js';

/**
 * Registers the `wabe start` subcommand: long-running daemon mode.
 *
 * Each source is scheduled independently per its `schedule` cron expression;
 * SIGINT/SIGTERM trigger a graceful shutdown that stops the scheduler, the
 * browser-bridge server (if enabled), the heartbeat writer, and aborts
 * in-flight work before exiting after a short drain delay.
 */
export function registerStart(prog: Command): void {
  prog
    .command('start')
    .description('Run as daemon (node-cron driven)')
    .action(async () => {
      const globalOpts = prog.opts<{ config?: string; dataDir?: string }>();
      const paths = resolvePaths({ config: globalOpts.config, dataDir: globalOpts.dataDir });
      const cfg = await loadConfig(paths.configDir, { dataDir: paths.dataDir });
      const logger = createLogger(cfg.top.log.level, process.stdout.isTTY);
      const db = openDb(paths.dbFile);
      migrate(db);
      const loaded = await loadPlugins(cfg);
      const breakers = new Map(
        loaded.sources.map((s) => [
          s.name,
          new CircuitBreaker({ failuresBeforeOpen: 3, cooldownMs: 600_000 }),
        ]),
      );
      const quota = new Quota(db, cfg.scoring.notify.daily_quota);
      const ctrl = new AbortController();
      const handle = scheduleSources(loaded.sources, logger, async (s) => {
        await runOnce({
          cfg,
          db,
          logger,
          signal: ctrl.signal,
          sources: [s],
          enrichers: loaded.enrichers,
          notifiers: loaded.notifiers,
          breakers,
          quota,
        });
        // Auto-discovery runs after each per-source tick. It dedupes against the
        // already-discovered registry, so the bounded `max_new_probes` cap means
        // repeated ticks degrade to a no-op once the local DB has been mined.
        await runDiscoveryCycle({
          cfg: cfg.top,
          db,
          dataDir: paths.dataDir,
          logger,
          signal: ctrl.signal,
        });
      });

      const shutdownHooks: Array<() => Promise<void> | void> = [];
      shutdownHooks.push(() => disposeSources(loaded.sources, logger));

      let bridge: BridgeServer | null = null;
      if (cfg.top.bridge.enabled) {
        bridge = await startBridgeServer({
          dataDir: paths.dataDir,
          port: cfg.top.bridge.port,
        });
        const liveBridge = bridge;
        const stopHeartbeat = startHeartbeat(paths.dataDir, () => liveBridge.status());
        shutdownHooks.push(stopHeartbeat);
        shutdownHooks.push(() => liveBridge.stop());
        logger.info({ host: '127.0.0.1', port: bridge.port }, 'browser bridge listening');
      }

      let shuttingDown = false;
      const shutdown = (sig: NodeJS.Signals): void => {
        if (shuttingDown) return;
        shuttingDown = true;
        logger.info({ sig }, 'shutting down');
        handle.stop();
        ctrl.abort();
        void Promise.allSettled(shutdownHooks.map((h) => h())).then(() => {
          setTimeout(() => process.exit(0), 500);
        });
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
      logger.info('wabe daemon up');
    });
}
