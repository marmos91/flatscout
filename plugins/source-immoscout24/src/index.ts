import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { Context, PluginExport, Source } from '@wabe/plugin-sdk';
import { IS24SrpListingSchema } from './parse.js';
import { mapSrpListing } from './map.js';
import { mergePdpIntoListing } from './enrich.js';
import { extractDetail } from './detail.js';
import { SearchConfig } from './search.js';
import { selectTransport, type Transport } from './transport.js';

const FetchConfig = z.object({
  // Pagination via read-state is a follow-up — requires SPA navigation in the
  // tab between page reads. For now the plugin scrapes whatever page the user
  // currently has loaded in their immoscout24 tab.
  max_pages: z.number().int().positive().default(1),
  pace_ms: z.number().int().nonnegative().default(2500),
  backoff: z
    .object({
      on: z.array(z.number()).default([429, 500, 502, 503, 504]),
      retries: z.number().int().nonnegative().default(3),
      base_ms: z.number().int().positive().default(2000),
    })
    .default({}),
});

const ReadStateResultSchema = z
  .object({
    listings: z.array(IS24SrpListingSchema),
    page: z.number().optional(),
    pageCount: z.number().optional(),
    resultCount: z.number().optional(),
    itemsPerPage: z.number().optional(),
    hasNextPage: z.boolean().optional(),
    hasPreviousPage: z.boolean().optional(),
  })
  .passthrough();

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
      // The plugin reads listings from whatever immoscout24 SRP the user
      // currently has open in their paired browser. DataDome refuses to serve
      // /rent?wzip=... as a raw fetch (only as SPA-emitted XHR from a fully-
      // hydrated tab), so emulating the fetch path is not viable. The
      // read-state contract: the user keeps a real browsing tab open at
      // www.immoscout24.ch; this plugin reads `window.__INITIAL_STATE__`
      // from it. See docs in transport.ts.
      const res = await transport.request({
        method: 'GET',
        url: 'https://www.immoscout24.ch/',
        signal: ctx.signal,
        logger: ctx.logger,
        readState: { jsPath: 'window.__INITIAL_STATE__.resultList.search.fullSearch.result' },
      });
      if (res.status === 404) {
        ctx.logger.warn(
          {},
          'immoscout24: no tab open at www.immoscout24.ch — open an SRP page in your paired browser to enable scanning',
        );
        return;
      }
      if (res.status < 200 || res.status >= 300) {
        ctx.logger.warn(
          { status: res.status, body_snippet: res.body.slice(0, 200) },
          'immoscout24: read-state failed',
        );
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(res.body);
      } catch {
        ctx.logger.warn({ body_snippet: res.body.slice(0, 200) }, 'immoscout24: read-state body is not JSON');
        return;
      }
      const validated = ReadStateResultSchema.safeParse(parsed);
      if (!validated.success) {
        ctx.logger.warn(
          { issues: validated.error.issues.slice(0, 5) },
          'immoscout24: read-state result does not match expected shape — is the user on a search results page?',
        );
        return;
      }
      const result = validated.data;
      ctx.logger.info(
        { count: result.listings.length, total: result.resultCount },
        'immoscout24: read state from open tab',
      );

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
