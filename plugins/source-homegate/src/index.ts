import { z } from 'zod';
import { Pool } from 'undici';
import type { Context, PluginExport, Source } from '@wabe/plugin-sdk';
import { SearchConfig } from './search.js';
import { fetchPage, sleep } from './client.js';
import { mapHomegateListing } from './map.js';

// All default credential values below come verbatim from the upstream
// reference implementation `denysvitali/homegate-rs` (MIT license), which
// extracted them from the official Homegate Android application:
//   - basic_user   src/api/mod.rs line 19:  "hg_android"
//   - basic_pass   src/api/mod.rs line 24:  "6VcGU6ceCFTk8dFm"
//   - app_secret   src/api/mod.rs line 30:  21-byte ASCII array decoding to "ABuTZrcTGKN4AwjHed3Hj"
//   - app_version  src/api/app_id.rs lines 47-50: "Homegate/12.6.0/12060003/Android/30"
//   - user_agent   src/api/mod.rs line 37:  "homegate.ch App Android"
const AuthSchema = z.object({
  basic_user: z.string().default('hg_android'),
  basic_pass: z.string().default('6VcGU6ceCFTk8dFm'),
  app_secret: z.string().default('ABuTZrcTGKN4AwjHed3Hj'),
  app_version: z.string().default('Homegate/12.6.0/12060003/Android/30'),
  user_agent: z.string().default('homegate.ch App Android'),
});

const FetchConfig = z.object({
  page_size: z.number().int().positive().default(50),
  max_pages: z.number().int().positive().default(3),
  pace_ms: z.number().int().nonnegative().default(5000),
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
  auth: AuthSchema.default({}),
  search: SearchConfig,
  fetch: FetchConfig.default({}),
});
type Config = z.infer<typeof ConfigSchema>;

/**
 * Homegate source plugin: paginates the mobile-app API up to `fetch.max_pages`
 * times using a dedicated undici Pool, yielding mapped listings. The Pool is
 * always closed in a `finally` so the iterator cleans up after early
 * termination or abort.
 */
const plugin: Source = {
  name: 'source-homegate',
  configSchema: ConfigSchema,
  async *fetch(ctx: Context) {
    const cfg = ctx.config as Config;
    const pool = new Pool('https://api.homegate.ch');
    try {
      for (let page = 0; page < cfg.fetch.max_pages; page += 1) {
        if (ctx.signal.aborted) return;
        const offset = page * cfg.fetch.page_size;
        const res = await fetchPage(cfg.search, cfg.fetch.page_size, offset, {
          pool,
          auth: cfg.auth,
          paceMs: cfg.fetch.pace_ms,
          backoff: cfg.fetch.backoff,
          signal: ctx.signal,
        });
        for (const item of res.results) yield mapHomegateListing(item.listing);
        if (res.results.length < cfg.fetch.page_size) break;
        if (page + 1 < cfg.fetch.max_pages) await sleep(cfg.fetch.pace_ms, ctx.signal);
      }
    } finally {
      await pool.close();
    }
  },
};

const exp: PluginExport = { kind: 'source', plugin };
export default exp;
