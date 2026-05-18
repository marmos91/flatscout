import { z } from 'zod';
import type { PluginExport, Source, Context } from '@wabe/plugin-sdk';
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
});
type Config = z.infer<typeof ConfigSchema>;

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    });
  });
}

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
    let scanned = 0;
    for (const e of filtered) {
      if (ctx.signal.aborted) return;
      if (scanned >= cfg.max_details_per_scan) break;
      scanned += 1;
      const payload = await fetchDetail(e.loc, ctx.signal);
      const mapped = mapDetail(e.loc, payload);
      if (mapped) yield mapped;
      await sleep(cfg.pace_ms, ctx.signal);
    }
  },
};

const exp: PluginExport = { kind: 'source', plugin };
export default exp;
