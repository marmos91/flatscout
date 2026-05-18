import { z } from 'zod';
import type { PluginExport, Source, Context } from '@wabe/plugin-sdk';
import { fetchSitemap } from './sitemap.js';
import { fetchDetail } from './detail.js';
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
});
type Config = z.infer<typeof ConfigSchema>;

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
    let scanned = 0;
    for (const e of entries) {
      if (ctx.signal.aborted) return;
      if (scanned >= cfg.max_details_per_scan) break;
      scanned += 1;
      try {
        const payload = await fetchDetail(e.loc, ctx.signal);
        const mapped = mapDetail(agencyId, e.loc, payload);
        if (mapped) yield mapped;
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
  },
};

const exp: PluginExport = { kind: 'source', plugin };
export default exp;
