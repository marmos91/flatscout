import { z } from 'zod';
import type { PluginExport, Source, Context } from '@flatscout/plugin-sdk';
import { SearchConfig, applyClientFilters } from './search.js';
import { fetchPage, sleep } from './client.js';
import { mapFlatfoxListing } from './map.js';
import { fetchCoverPhoto } from './photos.js';

const FetchConfig = z.object({
  page_size: z.number().int().positive().default(100),
  max_pages: z.number().int().positive().default(5),
  pace_ms: z.number().int().nonnegative().default(2000),
  /** When true, fetch the detail HTML page per listing to extract the cover photo URL (og:image). Adds one HTTP request per surviving listing. */
  enrich_photos: z.boolean().default(true),
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

/**
 * Flatfox source plugin: paginates the public listing API up to
 * `fetch.max_pages` times, applies client-side filters from `search`, and
 * yields each surviving raw listing. Honours abort signals between pages and
 * sleeps `fetch.pace_ms` between page requests to stay polite.
 */
const plugin: Source = {
  name: 'source-flatfox',
  configSchema: ConfigSchema,
  async *fetch(ctx: Context) {
    const cfg = ctx.config as Config;
    // NOTE: deviated from plan — dropped the per-fetch Pool in favour of
    // undici.request via the global dispatcher. Keeps connection pooling (the
    // global Agent pools by default) AND makes the source mockable in E2E
    // tests via setGlobalDispatcher(MockAgent).
    for (let page = 0; page < cfg.fetch.max_pages; page += 1) {
      if (ctx.signal.aborted) return;
      const offset = page * cfg.fetch.page_size;
      const res = await fetchPage(cfg.search, cfg.fetch.page_size, offset, {
        paceMs: cfg.fetch.pace_ms,
        backoff: cfg.fetch.backoff,
        signal: ctx.signal,
      });
      const filtered = applyClientFilters(res.results, cfg.search);
      for (const r of filtered) {
        const mapped = mapFlatfoxListing(r);
        if (cfg.fetch.enrich_photos && mapped.photos.length === 0) {
          const cover = await fetchCoverPhoto(mapped.url, { signal: ctx.signal });
          if (cover) mapped.photos = [cover];
          await sleep(cfg.fetch.pace_ms, ctx.signal);
        }
        yield mapped;
      }
      if (!res.next || res.results.length < cfg.fetch.page_size) break;
      if (page + 1 < cfg.fetch.max_pages) await sleep(cfg.fetch.pace_ms, ctx.signal);
    }
  },
};

const exp: PluginExport = { kind: 'source', plugin };
export default exp;
