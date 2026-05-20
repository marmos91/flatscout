import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { Context, PluginExport, Source } from '@wabe/plugin-sdk';
import { fetchSrp, sleep } from './client.js';
import { extractInitialState } from './parse.js';
import { mapSrpListing } from './map.js';
import { mergePdpIntoListing } from './enrich.js';
import { extractDetail } from './detail.js';
import { SearchConfig, buildSrpUrl } from './search.js';
import { selectTransport, type Transport } from './transport.js';

const FetchConfig = z.object({
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

const EnrichConfig = z.object({
  enrich_via_bridge: z.boolean().default(false),
  max_detail_per_scan: z.number().int().positive().default(40),
});

const ConfigSchema = z.object({
  schedule: z.string().default('*/15 * * * *'),
  search: SearchConfig.default({}),
  fetch: FetchConfig.default({}),
  enrich: EnrichConfig.default({}),
});
type Config = z.infer<typeof ConfigSchema>;

function resolveDataDir(): string {
  if (process.env.WABE_DATA_DIR) return process.env.WABE_DATA_DIR;
  const xdgData = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  return join(xdgData, 'wabe');
}

let activeTransport: Transport | undefined;

const plugin: Source = {
  name: 'source-immoscout24',
  configSchema: ConfigSchema,
  async *fetch(ctx: Context) {
    const cfg = ctx.config as Config;
    const dataDir = resolveDataDir();
    const transport = await selectTransport({ dataDir, logger: ctx.logger });
    activeTransport = transport;
    let pdpFetched = 0;

    try {
      for (let page = 1; page <= cfg.fetch.max_pages; page += 1) {
        if (ctx.signal.aborted) return;
        const url = buildSrpUrl(cfg.search, page);
        const res = await fetchSrp(url, {
          paceMs: cfg.fetch.pace_ms,
          backoff: cfg.fetch.backoff,
          signal: ctx.signal,
          logger: ctx.logger,
          transport,
        });
        const state = extractInitialState(res.body);
        if (!state) {
          ctx.logger.warn(
            {
              url,
              body_len: res.body.length,
              has_datadome: res.body.includes('datadome'),
              has_state_tag: res.body.includes('__INITIAL_STATE__'),
              head_snippet: res.body.slice(0, 300),
            },
            'immoscout24: SRP missing __INITIAL_STATE__ — skipping page',
          );
          break;
        }
        const result = state.resultList.search.fullSearch.result;

        for (const card of result.listings) {
          if (ctx.signal.aborted) return;
          let listing = mapSrpListing(card, cfg.search.language);
          if (!listing) {
            ctx.logger.warn({ id: card.id }, 'immoscout24: card missing id — skipping');
            continue;
          }
          if (cfg.enrich.enrich_via_bridge && pdpFetched < cfg.enrich.max_detail_per_scan) {
            try {
              const pdpRes = await transport.request({
                method: 'GET',
                url: listing.url,
                signal: ctx.signal,
                logger: ctx.logger,
                timeoutMs: 30_000,
              });
              if (pdpRes.status >= 200 && pdpRes.status < 300) {
                listing = mergePdpIntoListing(listing, extractDetail(pdpRes.body));
              } else {
                ctx.logger.warn(
                  { url: listing.url, status: pdpRes.status },
                  'immoscout24: PDP fetch non-2xx; emitting SRP-only',
                );
              }
              pdpFetched += 1;
            } catch (err) {
              ctx.logger.warn(
                { url: listing.url, err: (err as Error).message },
                'immoscout24: PDP fetch failed; emitting SRP-only',
              );
            }
          }
          yield listing;
        }

        if (!result.hasNextPage) break;
        if (result.listings.length < result.itemsPerPage) break;
        if (page < cfg.fetch.max_pages) await sleep(cfg.fetch.pace_ms, ctx.signal);
      }
    } finally {
      if (activeTransport === transport) activeTransport = undefined;
      if (transport.close) await transport.close();
    }
  },
  async dispose() {
    if (activeTransport?.close) await activeTransport.close();
    activeTransport = undefined;
  },
};

const exp: PluginExport = { kind: 'source', plugin };
export default exp;
