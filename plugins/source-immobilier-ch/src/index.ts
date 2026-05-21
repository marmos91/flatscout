import { z } from 'zod';
import type { PluginExport, Source, Context } from '@flatscout/plugin-sdk';
import { sleep } from '@flatscout/utils';
import { fetchSitemap } from './sitemap.js';
import { fetchDetail } from './detail.js';
import { mapDetail } from './map.js';

const ConfigSchema = z.object({
  schedule: z.string().default('*/15 * * * *'),
  sitemap_url: z.string().url().default('https://www.immobilier.ch/sitemap/rents.xml'),
  /** Honor site's stated Crawl-delay (5s); raise to be politer. */
  pace_ms: z.number().int().nonnegative().default(5000),
  /** Hard cap per scan run to bound runtime. */
  max_details_per_scan: z.number().int().positive().default(50),
  /** When true, the very first scan emits every URL. When false, the first scan only seeds state. */
  emit_on_first_scan: z.boolean().default(false),
  /** Only emit listings whose URL contains one of these substrings (e.g. ['zurich/zurich/']). Empty array = no filter. */
  url_must_include: z.array(z.string()).default([]),
  /**
   * Client-side PLZ allowlist. Empty array disables the filter. immobilier.ch
   * URLs like `/zurich/zurich/...` cover the whole city of Zürich (all 80xx
   * codes), so URL filtering is too coarse for a specific district. The
   * postal_code field on the mapped listing is checked after extraction;
   * null-PLZ listings drop when the allowlist is non-empty.
   */
  zipcodes: z.array(z.string().regex(/^\d{4}$/, 'PLZ must be a 4-digit Swiss postal code')).default([]),
});
type Config = z.infer<typeof ConfigSchema>;

const plugin: Source = {
  name: 'source-immobilier-ch',
  configSchema: ConfigSchema,
  async *fetch(ctx: Context) {
    const cfg = ctx.config as Config;
    const entries = await fetchSitemap(cfg.sitemap_url, ctx.signal);
    const filtered = entries.filter((e) =>
      cfg.url_must_include.length === 0 ? true : cfg.url_must_include.some((s) => e.loc.includes(s)),
    );
    // Sort by lastmod desc so newest listings get attention first within the per-scan cap.
    filtered.sort((a, b) => (b.lastmod ?? '').localeCompare(a.lastmod ?? ''));
    const zipAllow = new Set(cfg.zipcodes);
    let scanned = 0;
    let dropped = 0;
    for (const e of filtered) {
      if (ctx.signal.aborted) return;
      if (scanned >= cfg.max_details_per_scan) break;
      scanned += 1;
      const payload = await fetchDetail(e.loc, ctx.signal);
      const mapped = mapDetail(e.loc, payload);
      if (!mapped) continue;
      if (zipAllow.size > 0) {
        const plz = mapped.location.postal_code;
        if (!plz || !zipAllow.has(plz)) {
          dropped += 1;
          await sleep(cfg.pace_ms, ctx.signal);
          continue;
        }
      }
      yield mapped;
      await sleep(cfg.pace_ms, ctx.signal);
    }
    if (zipAllow.size > 0 && dropped > 0) {
      ctx.logger.info({ dropped, zipcodes: cfg.zipcodes }, 'immobilier-ch: zipcode filter dropped listings');
    }
  },
};

const exp: PluginExport = { kind: 'source', plugin };
export default exp;
