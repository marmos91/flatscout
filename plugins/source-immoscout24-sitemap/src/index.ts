import { z } from 'zod';
import type { PluginExport, Source, Context } from '@wabe/plugin-sdk';
import type { WabeDb } from '@wabe/db';
import { BrowserBridgeTransport, getCurrentBridge } from '@wabe/browser-bridge';
import { extractDetail } from './detail.js';
import { discoverRentLeaves, fetchSitemapLeaf, type SitemapEntry } from './sitemap.js';
import { loadSeenUrls, saveSeenUrls } from './state.js';
import { mapEntry } from './map.js';

const ConfigSchema = z.object({
  schedule: z.string().default('*/15 * * * *'),
  root_url: z.string().url().default('https://www.immoscout24.ch/sitemap/sitemap.xml'),
  /** Filter leaves to only specific languages to reduce work; defaults to German leaves. */
  languages: z.array(z.enum(['de', 'fr', 'it', 'en'])).default(['de']),
  /** When true, every URL in the very first scan is emitted as "new". When false, the first scan only seeds the state and emits nothing. */
  emit_on_first_scan: z.boolean().default(false),
  /**
   * When true and the browser bridge is connected, fetch each new PDP HTML
   * through the extension and emit full-detail listings (rooms / price /
   * description / photos). Otherwise emit URL-only listings.
   */
  enrich_via_bridge: z.boolean().default(true),
  /** Max PDPs to fetch per scan when bridge enrichment is on. Protects against floods on the first scan. */
  max_detail_per_scan: z.number().int().positive().default(40),
});
type Config = z.infer<typeof ConfigSchema>;

function bridgeReady(): boolean {
  // Bridge dispatch is in-process; sibling processes (one-shot `wabe scan`)
  // see the heartbeat file but can't actually route through it, so we only
  // accept an in-process paired bridge here.
  const inProc = getCurrentBridge();
  return inProc?.status().connected === true;
}

const plugin: Source = {
  name: 'source-immoscout24-sitemap',
  configSchema: ConfigSchema,
  async *fetch(ctx: Context) {
    const cfg = ctx.config as Config;
    const db = ctx.db as WabeDb;
    const leaves = await discoverRentLeaves(cfg.root_url, ctx.signal);
    const filtered = leaves.filter((url) =>
      cfg.languages.some((lang) => url.includes(`-RENT-${lang}.xml.gz`)),
    );
    const seen = loadSeenUrls(db);
    const newSeen = new Set(seen ?? []);
    const useBridge = cfg.enrich_via_bridge && bridgeReady();
    const transport = useBridge ? new BrowserBridgeTransport() : null;
    let detailFetched = 0;

    if (useBridge) ctx.logger.info('immoscout24: enriching via browser bridge');

    for (const leafUrl of filtered) {
      if (ctx.signal.aborted) return;
      let entries: SitemapEntry[];
      try {
        entries = await fetchSitemapLeaf(leafUrl, ctx.signal);
      } catch (err) {
        ctx.logger.warn({ leafUrl, err: (err as Error).message }, 'sitemap leaf failed; skipping');
        continue;
      }
      for (const e of entries) {
        if (!e.loc) continue;
        const isNew = !newSeen.has(e.loc);
        newSeen.add(e.loc);
        if (seen === null && !cfg.emit_on_first_scan) continue;
        if (!isNew) continue;

        let detailPayload = null;
        if (transport && detailFetched < cfg.max_detail_per_scan) {
          try {
            const resp = await transport.request({
              method: 'GET',
              url: e.loc,
              headers: { accept: 'text/html' },
              signal: ctx.signal,
              timeout_ms: 30_000,
            });
            if (resp.status >= 200 && resp.status < 300) {
              detailPayload = extractDetail(resp.body);
            } else {
              ctx.logger.warn(
                { url: e.loc, status: resp.status },
                'immoscout24 PDP fetch returned non-2xx; emitting URL-only',
              );
            }
            detailFetched += 1;
          } catch (err) {
            ctx.logger.warn(
              { url: e.loc, err: (err as Error).message },
              'immoscout24 PDP fetch failed; emitting URL-only',
            );
          }
        }

        const mapped = mapEntry(e, detailPayload);
        if (mapped) yield mapped;
      }
    }
    saveSeenUrls(db, newSeen);
  },
};

const exp: PluginExport = { kind: 'source', plugin };
export default exp;
