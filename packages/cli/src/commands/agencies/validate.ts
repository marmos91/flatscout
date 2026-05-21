import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { parse as parseYaml } from 'yaml';
import { request } from 'undici';
import { AgencyRegistry, type AgencyRegistry as AgencyRegistryType } from '@flatscout/core';

export function registerValidate(parent: Command): void {
  parent
    .command('validate <file>')
    .description('validate a registry file and probe each agency website for liveness')
    .action(async (file: string) => {
      const raw = parseYaml(readFileSync(resolve(file), 'utf8')) as unknown;
      let registry: AgencyRegistryType;
      try {
        registry = AgencyRegistry.parse(raw);
      } catch (err) {
        console.error(`schema validation failed: ${(err as Error).message}`);
        process.exit(1);
      }
      console.log(`registry: ${registry.source} — ${registry.agencies.length} entries`);
      let dead = 0;
      for (const a of registry.agencies) {
        try {
          const res = await request(a.website, { method: 'HEAD', signal: AbortSignal.timeout(10_000) });
          const ok = res.statusCode >= 200 && res.statusCode < 400;
          console.log(`${ok ? 'OK ' : 'X  '} ${a.id.padEnd(20)} ${res.statusCode} ${a.website}`);
          if (!ok) dead += 1;
        } catch (err) {
          console.log(`X   ${a.id.padEnd(20)} ERR ${a.website} — ${(err as Error).message}`);
          dead += 1;
        }
      }
      if (dead > 0) console.log(`\n${dead} dead/erroring entries.`);
    });
}
