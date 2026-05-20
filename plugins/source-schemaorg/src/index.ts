import { z } from 'zod';
import type { PluginExport, Source, Context } from '@wabe/plugin-sdk';
import { fetchSitemap } from './sitemap.js';
import { fetchDetail } from './detail.js';
import { extractListing } from './extract.js';
import { mapDetail } from './map.js';

const ConfigSchema = z.object({
  /** Injected by `expandRegistry` from the registry row's `id`. */
  agency_id: z.string().min(1),
  website: z.string().url(),
  /** Per-agency canton tag stored back into the listing for filter use. */
  canton: z.string().length(2),
  /** Polite pacing. Honor robots.txt Crawl-delay manually. */
  pace_ms: z.number().int().nonnegative().default(5000),
  max_details_per_scan: z.number().int().positive().default(30),
  /** Sitemap location relative to `website`, e.g. "/sitemap.xml". */
  sitemap_path: z.string().default('/sitemap.xml'),
  /** Optional explicit feed URL that overrides the website + sitemap_path concat. */
  feed_url: z.string().url().optional(),
  rate_limit_per_min: z.number().int().positive().default(6),
  priority: z.number().int().min(0).max(100).default(100),
  emit_on_first_scan: z.boolean().default(false),
  /** Optional URL template — reserved for future detail-URL synthesis paths; carried so registry rows can set it. */
  detail_url_template: z.string().optional(),
  /**
   * Optional regex applied to sitemap URLs; only matching URLs get a detail
   * fetch. Useful when a single sitemap mixes detail pages with category and
   * marketing pages (e.g. Ginesta's `/{lang}/(objects|immobilien)/<slug-id>/`).
   * String form (not Zod regex) so it round-trips through the inline-config
   * base64 carrier.
   */
  detail_url_pattern: z.string().optional(),
  /**
   * Geo pre-filter applied to extracted listings. A listing is kept when ANY
   * configured allowlist (postal_codes / cities / cantons) matches its
   * location fields; configuring zero allowlists disables the filter
   * entirely. Listings whose `location` is null on every probed field are
   * conservatively rejected when ANY filter is configured — we'd rather drop
   * an ambiguous listing than notify on something potentially outside the
   * user's zone.
   */
  region_filter: z
    .object({
      postal_codes: z.array(z.string().regex(/^\d{4}$/, 'PLZ must be a 4-digit Swiss postal code')).default([]),
      cities: z.array(z.string().min(1)).default([]),
      cantons: z.array(z.string().length(2)).default([]),
    })
    .default({ postal_codes: [], cities: [], cantons: [] }),
});
type Config = z.infer<typeof ConfigSchema>;

/**
 * Returns true when the listing's location matches at least one configured
 * allowlist (PLZ / city / canton). Caller has already ensured at least one
 * allowlist is non-empty. A listing whose `location` is null on every probed
 * field fails — better to drop ambiguous units than notify out-of-zone.
 */
function matchesRegion(
  listing: import('@wabe/core').RawListing,
  plz: Set<string>,
  cities: Set<string>,
  cantons: Set<string>,
): boolean {
  const { postal_code, city, region } = listing.location;
  if (plz.size > 0 && postal_code && plz.has(postal_code)) return true;
  if (cities.size > 0 && city && cities.has(city.toLowerCase())) return true;
  if (cantons.size > 0 && region && cantons.has(region.toUpperCase())) return true;
  return false;
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  // Bail immediately if already aborted — `addEventListener('abort')` only fires
  // on *future* abort events, so a controller aborted before sleep() is entered
  // would otherwise stall for the full duration.
  if (signal.aborted) throw new Error('aborted');
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    });
  });
}

const plugin: Source = {
  name: 'source-schemaorg',
  configSchema: ConfigSchema,
  async *fetch(ctx: Context) {
    const cfg = ctx.config as Config;
    const agencyId = cfg.agency_id;
    const sitemapUrl = cfg.feed_url ?? new URL(cfg.sitemap_path, cfg.website).toString();
    const entries = await fetchSitemap(sitemapUrl, ctx.signal);
    entries.sort((a, b) => (b.lastmod ?? '').localeCompare(a.lastmod ?? ''));
    const detailPattern = cfg.detail_url_pattern ? new RegExp(cfg.detail_url_pattern) : null;
    const regionEnabled =
      cfg.region_filter.postal_codes.length > 0 ||
      cfg.region_filter.cities.length > 0 ||
      cfg.region_filter.cantons.length > 0;
    const allowedPlz = new Set(cfg.region_filter.postal_codes);
    const allowedCities = new Set(cfg.region_filter.cities.map((c) => c.toLowerCase()));
    const allowedCantons = new Set(cfg.region_filter.cantons.map((c) => c.toUpperCase()));
    let scanned = 0;
    let droppedByRegion = 0;
    for (const e of entries) {
      if (ctx.signal.aborted) return;
      if (scanned >= cfg.max_details_per_scan) break;
      if (detailPattern && !detailPattern.test(e.loc)) continue;
      scanned += 1;
      try {
        const detail = await fetchDetail(e.loc, ctx.signal);
        const extracted = extractListing(detail.html, e.loc);
        const mapped = mapDetail(agencyId, e.loc, extracted);
        if (!mapped) {
          ctx.logger.debug({ url: e.loc }, 'schemaorg: no listing extracted');
        } else if (regionEnabled && !matchesRegion(mapped, allowedPlz, allowedCities, allowedCantons)) {
          droppedByRegion += 1;
          ctx.logger.debug(
            {
              url: e.loc,
              postal_code: mapped.location.postal_code,
              city: mapped.location.city,
              region: mapped.location.region,
            },
            'schemaorg: dropped by region_filter',
          );
        } else {
          yield mapped;
        }
      } catch (err) {
        ctx.logger.warn({ url: e.loc, err: (err as Error).message }, 'schemaorg detail failed');
      }
      if (ctx.signal.aborted) return;
      try {
        await sleep(cfg.pace_ms, ctx.signal);
      } catch {
        // sleep rejects on abort; treat as graceful termination of the scan loop.
        return;
      }
    }
    if (regionEnabled && droppedByRegion > 0) {
      ctx.logger.info(
        { dropped: droppedByRegion, scanned },
        'schemaorg: region_filter dropped listings',
      );
    }
  },
};

const exp: PluginExport = { kind: 'source', plugin };
export default exp;
