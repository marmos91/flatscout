import { z } from 'zod';
import type { PluginExport, Source, Context } from '@wabe/plugin-sdk';
import { Pool } from 'undici';
import { SearchConfig, applyClientFilters } from './search.js';
import { fetchPage, sleep } from './client.js';
import { mapFlatfoxListing } from './map.js';

const FetchConfig = z.object({
  page_size: z.number().int().positive().default(100),
  max_pages: z.number().int().positive().default(5),
  pace_ms: z.number().int().nonnegative().default(2000),
  backoff: z
    .object({
      on: z.array(z.number()).default([429, 500, 502, 503, 504]),
      retries: z.number().int().nonnegative().default(3),
      base_ms: z.number().int().positive().default(2000),
    })
    .default({}),
});

const ConfigSchema = z.object({
  schedule: z.string().default('*/2 * * * *'),
  search: SearchConfig.default({}),
  fetch: FetchConfig.default({}),
});
type Config = z.infer<typeof ConfigSchema>;

const plugin: Source = {
  name: 'source-flatfox',
  configSchema: ConfigSchema,
  async *fetch(ctx: Context) {
    const cfg = ctx.config as Config;
    const pool = new Pool('https://flatfox.ch');
    try {
      for (let page = 0; page < cfg.fetch.max_pages; page += 1) {
        if (ctx.signal.aborted) return;
        const offset = page * cfg.fetch.page_size;
        const res = await fetchPage(cfg.search, cfg.fetch.page_size, offset, {
          pool,
          paceMs: cfg.fetch.pace_ms,
          backoff: cfg.fetch.backoff,
          signal: ctx.signal,
        });
        const filtered = applyClientFilters(res.results, cfg.search);
        for (const r of filtered) yield mapFlatfoxListing(r);
        if (!res.next || res.results.length < cfg.fetch.page_size) break;
        if (page + 1 < cfg.fetch.max_pages) await sleep(cfg.fetch.pace_ms, ctx.signal);
      }
    } finally {
      await pool.close();
    }
  },
};

const exp: PluginExport = { kind: 'source', plugin };
export default exp;
