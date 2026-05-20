import type { Command } from 'commander';
import { fingerprint } from '@wabe/agency-fingerprint';
import { type Candidate, extractDescriptionUrls, normaliseToCandidate } from '@wabe/server';
import { stringify as yamlStringify } from 'yaml';
import { getPortal, listPortals } from './portals/index.js';

interface ProbeOpts {
  top: string;
  pacingMs: string;
  enable?: boolean;
}

export function registerProbePortal(parent: Command): void {
  parent
    .command('probe-portal <portal>')
    .description("mine a portal's listing pages for agency URLs, fingerprint each, emit draft rows")
    .option('--top <n>', 'number of listings to scan', '100')
    .option('--pacing-ms <n>', 'milliseconds between fingerprint probes', '1500')
    .option('--enable', 'emit rows with enabled: true (default: false, for manual review)')
    .action(async (portal: string, opts: ProbeOpts) => {
      const impl = getPortal(portal);
      if (!impl) {
        console.error(`unsupported portal: ${portal}. supported: ${listPortals().join(', ')}`);
        process.exit(1);
      }
      const top = Number.parseInt(opts.top, 10);
      const pacingMs = Number.parseInt(opts.pacingMs, 10);
      const enable = opts.enable ?? false;

      const ac = new AbortController();
      const onSig = (): void => ac.abort();
      process.on('SIGINT', onSig);
      process.on('SIGTERM', onSig);

      try {
        console.log(`# probing top ${top} listings on ${portal}`);
        const listings = await impl.fetchTop(top, ac.signal, (m) => console.log(`# ${m}`));
        console.log(`# fetched ${listings.length} listings`);

        // Dedupe candidates by id. Each unique URL produces one fingerprint
        // probe regardless of how many listings surfaced it.
        const candidates = new Map<string, Candidate>();
        for (const l of listings) {
          if (l.agency_website) {
            const c = normaliseToCandidate(l.agency_website, 'lister-website', l.agency_name ?? undefined);
            if (c && !candidates.has(c.id)) candidates.set(c.id, c);
          }
          if (l.description) {
            for (const c of extractDescriptionUrls(l.description)) {
              if (!candidates.has(c.id)) candidates.set(c.id, c);
            }
          }
        }
        console.log(`# extracted ${candidates.size} unique candidate domains`);

        const rows: object[] = [];
        let probed = 0;
        for (const candidate of candidates.values()) {
          if (ac.signal.aborted) break;
          probed += 1;
          try {
            const fp = await fingerprint(candidate.website, ac.signal);
            console.log(`# probe ${candidate.id}: ${fp.platform} (${fp.reason})`);
            rows.push({
              id: candidate.id,
              name: candidate.legal_name ?? candidate.id,
              website: candidate.website,
              canton: 'ZH',
              platform: fp.platform === 'iframe-portal' ? 'custom' : fp.platform,
              rate_limit_per_min: 6,
              priority: 100,
              enabled: enable,
              notes: `discovered via probe-portal ${portal} on ${new Date().toISOString().slice(0, 10)}`,
            });
          } catch (err) {
            console.log(`# probe ${candidate.id}: error ${(err as Error).message}`);
          }
          if (probed < candidates.size) {
            await new Promise<void>((resolve) => setTimeout(resolve, pacingMs));
          }
        }

        console.log(`# emitting ${rows.length} suggested registry rows:`);
        console.log(yamlStringify({ agencies: rows }));
      } finally {
        process.off('SIGINT', onSig);
        process.off('SIGTERM', onSig);
      }
    });
}
