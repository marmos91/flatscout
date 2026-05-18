import type { Command } from 'commander';
import { fingerprint } from '@wabe/agency-fingerprint';

export function registerProbe(parent: Command): void {
  parent
    .command('probe <url>')
    .description('fingerprint one agency URL and print a suggested registry row')
    .action(async (url: string) => {
      const ac = new AbortController();
      const result = await fingerprint(url, ac.signal);
      const slug = new URL(url).hostname.replace(/^www\./, '').split('.')[0] ?? 'unknown';
      console.log(`# detected platform: ${result.platform} (status ${result.status})`);
      console.log(`- id: ${slug}`);
      console.log(`  name: ${slug}`);
      console.log(`  website: ${url}`);
      console.log(`  canton: ZH`);
      console.log(`  platform: ${result.platform}`);
    });
}
