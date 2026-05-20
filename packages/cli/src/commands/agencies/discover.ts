import { join } from 'node:path';
import type { Command } from 'commander';
import { openDb } from '@wabe/db';
import { discoverAgencies } from '@wabe/server';
import { resolvePaths } from '../../paths.js';

export function registerDiscover(parent: Command): void {
  parent
    .command('discover')
    .description(
      'mine the local DB for agency candidates, fingerprint each, append to agencies.discovered.yaml',
    )
    .option('--max <n>', 'cap on new probes per run', (v) => Number.parseInt(v, 10), 25)
    .option('--pacing-ms <n>', 'milliseconds between probes', (v) => Number.parseInt(v, 10), 1500)
    .option('--no-legal-names', 'skip DuckDuckGo resolution from lister.legal_name')
    .option('--enable', 'mark discovered rows enabled: true (default: disabled)')
    .action(
      async (opts: { max: number; pacingMs: number; legalNames: boolean; enable: boolean }) => {
        const paths = resolvePaths();
        const db = openDb(paths.dbFile);
        const outFile = join(paths.dataDir, 'agencies.discovered.yaml');
        const ac = new AbortController();
        const onSig = () => ac.abort();
        process.on('SIGINT', onSig);
        process.on('SIGTERM', onSig);
        console.log(`mining ${paths.dbFile} → ${outFile}`);
        const summary = await discoverAgencies({
          db: db._raw,
          outFile,
          maxNewProbes: opts.max,
          pacingMs: opts.pacingMs,
          resolveLegalNames: opts.legalNames,
          enabledByDefault: opts.enable,
          signal: ac.signal,
          log: (m) => console.log(`  ${m}`),
        });
        process.off('SIGINT', onSig);
        process.off('SIGTERM', onSig);
        console.log('');
        console.log('summary:');
        console.log(`  total_candidates  : ${summary.total_candidates}`);
        console.log(`  already_known     : ${summary.already_known}`);
        console.log(`  probed            : ${summary.probed}`);
        console.log(`  added             : ${summary.added}`);
        console.log(`  skipped_no_resolve: ${summary.skipped_no_resolve}`);
        console.log(`  errors            : ${summary.errors}`);
        console.log('  by_platform       :');
        for (const [plat, count] of Object.entries(summary.by_platform)) {
          console.log(`    ${plat.padEnd(15)} ${count}`);
        }
      },
    );
}
