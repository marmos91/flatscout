import type { Command } from 'commander';
import { fingerprint } from '@wabe/agency-fingerprint';

const SUPPORTED_PORTALS = ['flatfox'] as const;
type Portal = (typeof SUPPORTED_PORTALS)[number];

export function registerProbePortal(parent: Command): void {
  parent
    .command('probe-portal <portal>')
    .description("mine a portal's listing pages for agency URLs, fingerprint each, emit draft rows")
    .option('--top <n>', 'number of listings to scan', '100')
    .action(async (portal: string, opts: { top: string }) => {
      if (!SUPPORTED_PORTALS.includes(portal as Portal)) {
        console.error(`unsupported portal: ${portal}. supported: ${SUPPORTED_PORTALS.join(', ')}`);
        process.exit(1);
      }
      const top = Number.parseInt(opts.top, 10);
      console.log(`# probing top ${top} listings on ${portal}`);
      // NOTE: scaffold-only per Phase C plan §Task 11. The actual implementation
      // reuses the source-flatfox client to fetch listing detail pages and
      // extract `agency_url` from each. Per-portal extraction will live in
      // packages/cli/src/commands/agencies/portals/. Full implementation is
      // gated on the discovery spike output (which uses this command itself).
      console.log('# NOTE: probe-portal scaffolding only — portal-specific extractor TBD in followup task.');
      console.log(`# expected output once implemented: ${top} suggested registry rows as YAML.`);
      const ac = new AbortController();
      // demo: fingerprint one well-known agency URL just to exercise the plumbing
      const sample = 'https://walde.ch';
      const r = await fingerprint(sample, ac.signal);
      console.log(`# sample probe of ${sample} → platform=${r.platform}`);
    });
}
