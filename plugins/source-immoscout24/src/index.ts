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

const ReadStateResultInnerSchema = z
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

/**
 * Shape of the slice we read from `window.__INITIAL_STATE__.resultList.search.fullSearch`:
 * `result` carries the listing array; `searchModel` carries the live filter
 * state the user has applied in the tab. We compare yaml `cfg.search` against
 * `searchModel` to warn the user when their yaml filters are being ignored.
 */
const ReadStateResultSchema = z
  .object({
    result: ReadStateResultInnerSchema,
    searchModel: z
      .object({
        sortType: z.string().optional(),
        sortDirection: z.string().optional(),
        chooseType: z.string().optional(),
        offerType: z.string().optional(),
        locations: z.array(z.string()).optional(),
        page: z.number().optional(),
        pageSize: z.number().optional(),
        facilitiesRequired: z.array(z.string()).optional(),
        objectTypes: z.array(z.string()).optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
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

/**
 * Returns true when the user has yaml-configured filters that this source
 * cannot honour. Default values from {@link SearchConfig} (empty zipcodes,
 * generic property/offer type, default sort) don't count as "configured" —
 * they're the same as no input. Anything else (zipcodes, price range, rooms
 * range, surface min, balcony/elevator flag, non-default sort) does.
 */
function hasUserConfiguredFilters(search: SearchConfig): boolean {
  if (search.zipcodes.length > 0) return true;
  if (search.price_min != null || search.price_max != null) return true;
  if (search.rooms_min != null || search.rooms_max != null) return true;
  if (search.surface_min != null) return true;
  if (search.has_balcony != null || search.has_elevator != null) return true;
  if (search.property_type !== 'APARTMENT_OR_HOUSE') return true;
  if (search.sort_by !== 'dateCreated' || search.sort_direction !== 'desc') return true;
  return false;
}

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
        // Read the whole `fullSearch` slice so we can both:
        //   - extract `.result` (listings + paging)
        //   - inspect `.searchModel` (the live tab's filter state) to warn
        //     when the user's yaml `cfg.search` doesn't match the tab.
        readState: { jsPath: 'window.__INITIAL_STATE__.resultList.search.fullSearch' },
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
      const fullSearch = validated.data;
      const result = fullSearch.result;
      // One-shot per-scan warning when yaml `cfg.search` is non-empty: this
      // source reads the live tab's filter state, not the configured one, so
      // yaml filters are silently ignored. Surface the drift loudly so users
      // don't sit on stale results forever wondering why their config changes
      // do nothing.
      if (hasUserConfiguredFilters(cfg.search)) {
        ctx.logger.warn(
          {
            configured: cfg.search,
            tab_filters: fullSearch.searchModel ?? null,
          },
          'immoscout24: cfg.search is ignored — this source reads the live filter state from your open browser tab. To change filters, navigate inside the tab.',
        );
      }
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
