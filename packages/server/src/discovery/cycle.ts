import { join } from 'node:path';
import type { Logger } from 'pino';
import type { FlatscoutDb } from '@flatscout/db';
import type { TopConfig } from '../config.js';
import { discoverAgencies } from './discover.js';

export interface CycleHookOpts {
  cfg: TopConfig;
  db: FlatscoutDb;
  dataDir: string;
  logger: Logger;
  signal: AbortSignal;
}

/**
 * Post-scan-cycle hook that runs auto-discovery when enabled. Pulls candidates
 * from the local DB, fingerprints up to `max_new_probes` new domains, and
 * appends the schemaorg/casasoft/immomig hits to `agencies.discovered.yaml`.
 *
 * Always swallows its own errors (logged via `logger.warn`) so a failing
 * discovery run never blocks the next scheduled scan tick.
 */
export async function runDiscoveryCycle(opts: CycleHookOpts): Promise<void> {
  const d = opts.cfg.discovery;
  if (!d?.enabled) return;
  const outFile = join(opts.dataDir, 'agencies.discovered.yaml');
  try {
    const summary = await discoverAgencies({
      db: opts.db._raw,
      outFile,
      maxNewProbes: d.max_new_probes,
      pacingMs: d.pacing_ms,
      resolveLegalNames: d.resolve_legal_names,
      mineDescriptionUrls: d.mine_description_urls,
      newBuildOnly: d.new_build_only,
      externalSeeds: d.external_seeds,
      enabledByDefault: d.auto_enable,
      signal: opts.signal,
      log: (m) => opts.logger.debug({ discovery: true }, m),
    });
    opts.logger.info(
      { discovery: summary },
      `discovery: probed ${summary.probed}, added ${summary.added}, by_platform ${JSON.stringify(summary.by_platform)}`,
    );
  } catch (err) {
    opts.logger.warn({ err }, 'discovery cycle failed');
  }
}
