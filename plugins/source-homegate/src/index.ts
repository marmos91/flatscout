import { z } from 'zod';
import type { Context, PluginExport, Source } from '@flatscout/plugin-sdk';
import { resolveDataDir, sleep } from '@flatscout/utils';
import { fetchSearch } from './client.js';
import { mapHomegateResult, HomegateApiSchema } from './map.js';
import { buildSearchBody, SearchConfig } from './search.js';
import { selectTransport, type Transport } from './transport.js';

const FetchConfig = z.object({
  page_size: z.number().int().positive().max(50).default(20),
  max_pages: z.number().int().positive().default(5),
  pace_ms: z.number().int().nonnegative().default(2500),
  backoff: z
    .object({
      on: z.array(z.number()).default([429, 500, 502, 503, 504]),
      retries: z.number().int().nonnegative().default(3),
      base_ms: z.number().int().positive().default(2000),
    })
    .default({}),
});

const ConfigSchema = z.object({
  schedule: z.string().default('*/5 * * * *'),
  search: SearchConfig.default({}),
  fetch: FetchConfig.default({}),
});
type Config = z.infer<typeof ConfigSchema>;

let activeTransport: Transport | undefined;

/**
 * Homegate source plugin: paginates the iOS-style anonymous search endpoint
 * through the Flatscout browser bridge. DataDome's anti-bot challenge requires
 * requests originate from a real Homegate page context — bridge is the only
 * viable transport.
 */
const plugin: Source = {
  name: 'source-homegate',
  configSchema: ConfigSchema,
  async *fetch(ctx: Context) {
    const cfg = ctx.config as Config;
    const dataDir = resolveDataDir();

    const transport = await selectTransport({ dataDir, logger: ctx.logger });
    activeTransport = transport;

    try {
      for (let page = 0; page < cfg.fetch.max_pages; page += 1) {
        if (ctx.signal.aborted) return;
        const from = page * cfg.fetch.page_size;
        const body = buildSearchBody(cfg.search, cfg.fetch.page_size, from);
        const res = await fetchSearch(body, {
          paceMs: cfg.fetch.pace_ms,
          backoff: cfg.fetch.backoff,
          signal: ctx.signal,
          logger: ctx.logger,
          transport,
        });

        for (const raw of res.results) {
          const parsed = HomegateApiSchema.safeParse(raw);
          if (!parsed.success) {
            ctx.logger.warn(
              { err: parsed.error.message, listing_id: (raw as { id?: string }).id },
              'skipping malformed homegate result',
            );
            continue;
          }
          yield mapHomegateResult(parsed.data);
        }

        // Stop on last page / empty page / explicit cap.
        const next = from + res.results.length;
        if (res.results.length < cfg.fetch.page_size) break;
        if (next >= res.total) break;
        if (res.maxFrom != null && next >= res.maxFrom) break;
        if (page + 1 < cfg.fetch.max_pages) await sleep(cfg.fetch.pace_ms, ctx.signal);
      }
    } finally {
      // CLOSE GUARANTEE: each fetch invocation closes its own transport, even
      // if a concurrent invocation reassigned `activeTransport`. The module
      // singleton is only kept around so `dispose()` can act as a safety net
      // for abrupt shutdown (signal handlers, crashed pipelines).
      if (activeTransport === transport) activeTransport = undefined;
      if (transport.close) {
        await transport.close();
      }
    }
  },
  async dispose() {
    if (activeTransport?.close) {
      await activeTransport.close();
    }
    activeTransport = undefined;
  },
};

/**
 * Public named exports for HG clients (e.g. `@flatscout/cli`'s login/logout). The
 * plugin is the canonical source of truth for the OAuth2 wire shape; clients
 * import these instead of duplicating the literals.
 */
export { AUDIENCE, AUTH_BASE, CLIENT_ID, REDIRECT_URI, SCOPE } from './constants.js';

const exp: PluginExport = { kind: 'source', plugin };
export default exp;
