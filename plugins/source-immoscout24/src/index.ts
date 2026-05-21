import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { Context, PluginExport, Source } from '@flatscout/plugin-sdk';
import { IS24SrpListingSchema } from './parse.js';
import { mapSrpListing } from './map.js';
import { mergePdpIntoListing } from './enrich.js';
import { extractDetail } from './detail.js';
import { SearchConfig } from './search.js';
import { selectTransport, type ReadStateActionInput, type Transport } from './transport.js';

const FetchConfig = z.object({
  // Pagination is driven via in-tab SPA navigation through the bridge's
  // read-state action protocol. Each extra page costs one bridge round-trip
  // (click next + wait for state to hydrate). Capped at 20 to bound runtime
  // and keep tab interaction polite.
  max_pages: z.number().int().positive().max(20).default(3),
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
type ReadStateResult = z.infer<typeof ReadStateResultSchema>;

// Read the whole `fullSearch` slice: `.result` is listings + paging, and
// `.searchModel` carries the live tab filter state used by the one-shot
// config-drift warning below.
const STATE_PATH = 'window.__INITIAL_STATE__.resultList.search.fullSearch';

/**
 * MAIN-world JS that finds and clicks the SRP pagination "next" control.
 *
 * Selector priority (most robust first):
 *  1. `a[rel="next"]` — the IS24 SRP renders this on the rendered pagination
 *     <a> anchor; standardized HTML semantic, won't change with copy edits.
 *  2. `[data-test*="pagination-next" i]` — IS24's QA hook attribute.
 *  3. `[aria-label*="next" i]` / `[aria-label*="weiter" i]` /
 *     `[aria-label*="suivant" i]` — accessibility labels across DE/EN/FR.
 *
 * We deliberately avoid matching visible text content because (a) it's
 * locale-dependent and (b) the user can't see this script. Throws if no
 * candidate is found so the bridge surfaces a 422.
 */
const NEXT_PAGE_CLICK_JS = `
  var el =
    document.querySelector('a[rel="next"]') ||
    document.querySelector('[data-test*="pagination-next" i]') ||
    document.querySelector('[aria-label*="next" i]') ||
    document.querySelector('[aria-label*="weiter" i]') ||
    document.querySelector('[aria-label*="suivant" i]');
  if (!el) throw new Error('no next-page element found on the SRP');
  el.click();
`.trim();

function waitForPagePredicate(expectedPage: number): string {
  return `(${STATE_PATH} && ${STATE_PATH}.result && ${STATE_PATH}.result.page === ${expectedPage})`;
}

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
  if (process.env.FLATSCOUT_DATA_DIR) return process.env.FLATSCOUT_DATA_DIR;
  const xdgData = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  return join(xdgData, 'flatscout');
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

interface ReadPageOutcome {
  kind: 'ok';
  result: ReadStateResult;
}
interface ReadPageFailure {
  kind: 'err';
  /** Coarse classification for log + control flow. */
  reason: 'no-tab' | 'http' | 'parse' | 'shape';
  status: number;
  detail?: string;
  issues?: unknown;
}

async function readPage(
  transport: Transport,
  ctx: Context,
  actions?: ReadStateActionInput[],
): Promise<ReadPageOutcome | ReadPageFailure> {
  const res = await transport.request({
    method: 'GET',
    url: 'https://www.immoscout24.ch/',
    signal: ctx.signal,
    logger: ctx.logger,
    readState: { jsPath: STATE_PATH, ...(actions ? { actions } : {}) },
  });
  if (res.status === 404) {
    return { kind: 'err', reason: 'no-tab', status: 404 };
  }
  if (res.status < 200 || res.status >= 300) {
    return { kind: 'err', reason: 'http', status: res.status, detail: res.body.slice(0, 200) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    return { kind: 'err', reason: 'parse', status: 200, detail: res.body.slice(0, 200) };
  }
  const validated = ReadStateResultSchema.safeParse(parsed);
  if (!validated.success) {
    return { kind: 'err', reason: 'shape', status: 200, issues: validated.error.issues.slice(0, 5) };
  }
  return { kind: 'ok', result: validated.data };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    if (ms <= 0) {
      resolve();
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
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
      //
      // For pagination we drive SPA navigation in the tab between reads via
      // the bridge's read-state `actions` channel: click the next-page
      // anchor, wait for the Pinia store's `result.page` to increment, then
      // re-read state.
      const yielded = new Set<string>();
      let pagesRead = 0;
      let lastPage: number | undefined;

      while (pagesRead < cfg.fetch.max_pages) {
        if (ctx.signal.aborted) return;

        const isFirst = pagesRead === 0;
        const actions: ReadStateActionInput[] | undefined = isFirst
          ? undefined
          : [
              { kind: 'eval', js: NEXT_PAGE_CLICK_JS },
              {
                kind: 'wait_for',
                js_predicate: waitForPagePredicate((lastPage ?? 1) + 1),
                timeout_ms: 10_000,
                poll_ms: 200,
              },
            ];

        if (!isFirst && cfg.fetch.pace_ms > 0) {
          try {
            await sleep(cfg.fetch.pace_ms, ctx.signal);
          } catch {
            return;
          }
        }

        const outcome = await readPage(transport, ctx, actions);
        if (outcome.kind === 'err') {
          if (outcome.reason === 'no-tab') {
            ctx.logger.warn(
              {},
              'immoscout24: no tab open at www.immoscout24.ch — open an SRP page in your paired browser to enable scanning',
            );
            return;
          }
          if (outcome.reason === 'http') {
            // 408 = wait_for timeout, 422 = eval threw / predicate threw.
            ctx.logger.warn(
              { status: outcome.status, body_snippet: outcome.detail, page_attempt: pagesRead + 1 },
              isFirst
                ? 'immoscout24: read-state failed'
                : 'immoscout24: pagination read-state failed — emitting accumulated listings',
            );
            return;
          }
          if (outcome.reason === 'parse') {
            ctx.logger.warn({ body_snippet: outcome.detail }, 'immoscout24: read-state body is not JSON');
            return;
          }
          ctx.logger.warn(
            { issues: outcome.issues },
            'immoscout24: read-state result does not match expected shape — is the user on a search results page?',
          );
          return;
        }

        const fullSearch = outcome.result;
        const result = fullSearch.result;
        pagesRead += 1;

        // One-shot per-scan drift warning. The tab's filter state doesn't
        // change mid-scan, so only fire on the first successful read. yaml
        // `cfg.search` is silently ignored by this source — surface the drift
        // loudly so users don't sit on stale results forever wondering why
        // their config changes do nothing.
        if (isFirst && hasUserConfiguredFilters(cfg.search)) {
          ctx.logger.warn(
            {
              configured: cfg.search,
              tab_filters: fullSearch.searchModel ?? null,
            },
            'immoscout24: cfg.search is ignored — this source reads the live filter state from your open browser tab. To change filters, navigate inside the tab.',
          );
        }

        // Defensive: if the predicate-guard slipped and we got the same page
        // back, bail rather than spin or double-emit silently. The dedup set
        // would already suppress emissions; this avoids burning the loop.
        if (!isFirst && lastPage !== undefined && result.page !== undefined && result.page <= lastPage) {
          ctx.logger.warn(
            { last_page: lastPage, got_page: result.page },
            'immoscout24: pagination did not advance — stopping',
          );
          break;
        }

        ctx.logger.info(
          {
            page: result.page,
            page_count: result.pageCount,
            count: result.listings.length,
            total: result.resultCount,
          },
          'immoscout24: read state from open tab',
        );

        for (const card of result.listings) {
          if (ctx.signal.aborted) return;
          if (yielded.has(card.id)) continue;
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
          yielded.add(card.id);
          yield listing;
        }

        lastPage = result.page;

        // Stop conditions: explicit hasNextPage=false, or we've reached the
        // last page per pageCount. If `page` is absent from the response
        // (Pinia schema marks it optional), we cannot drive SPA navigation
        // deterministically — emit what we got and stop rather than spin on
        // a stale wait_for predicate.
        if (result.hasNextPage === false) break;
        if (result.page === undefined) {
          if (pagesRead < cfg.fetch.max_pages) {
            ctx.logger.warn(
              {},
              'immoscout24: read-state lacks `page` field — pagination disabled, emitting only the current page',
            );
          }
          break;
        }
        if (result.pageCount !== undefined && result.page >= result.pageCount) {
          break;
        }
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
