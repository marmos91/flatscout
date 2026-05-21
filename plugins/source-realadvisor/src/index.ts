import { z } from 'zod';
import type { PluginExport, Source, Context } from '@flatscout/plugin-sdk';
import { SearchConfig } from './search.js';
import { fetchPage, sleep } from './client.js';
import { mapHit } from './map.js';

const FetchConfig = z.object({
  page_size: z.literal(36).default(36),
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
  schedule: z.string().default('*/3 * * * *'),
  search: SearchConfig.default({}),
  fetch: FetchConfig.default({}),
});
type Config = z.infer<typeof ConfigSchema>;

const plugin: Source = {
  name: 'source-realadvisor',
  configSchema: ConfigSchema,
  async *fetch(ctx: Context) {
    const cfg = ctx.config as Config;
    const zipAllow = new Set(cfg.search.zipcodes);
    let dropped = 0;
    for (let page = 1; page <= cfg.fetch.max_pages; page += 1) {
      if (ctx.signal.aborted) return;
      const res = await fetchPage(cfg.search, page, {
        paceMs: cfg.fetch.pace_ms,
        backoff: cfg.fetch.backoff,
        signal: ctx.signal,
      });
      for (const hit of res.listings) {
        const mapped = mapHit(hit);
        if (!mapped) continue;
        if (zipAllow.size > 0) {
          const plz = mapped.location.postal_code;
          if (!plz || !zipAllow.has(plz)) {
            dropped += 1;
            continue;
          }
        }
        yield mapped;
      }
      if (res.listings.length < 36) break;
      if (page < cfg.fetch.max_pages) await sleep(cfg.fetch.pace_ms, ctx.signal);
    }
    if (zipAllow.size > 0 && dropped > 0) {
      ctx.logger.info(
        { dropped, zipcodes: cfg.search.zipcodes },
        'realadvisor: zipcode filter dropped listings',
      );
    }
  },
};

const exp: PluginExport = { kind: 'source', plugin };
export default exp;
