import { z } from 'zod';
import type { PluginExport, Source, Context } from '@wabe/plugin-sdk';
import type { WabeDb } from '@wabe/db';
import { discoverRentLeaves, fetchSitemapLeaf } from './sitemap.js';
import { loadSeenUrls, saveSeenUrls } from './state.js';
import { mapEntry } from './map.js';

const ConfigSchema = z.object({
  schedule: z.string().default('*/15 * * * *'),
  root_url: z.string().url().default('https://www.immoscout24.ch/sitemap/sitemap.xml'),
  /** Filter leaves to only specific languages to reduce work; defaults to German leaves. */
  languages: z.array(z.enum(['de', 'fr', 'it', 'en'])).default(['de']),
  /** When true, every URL in the very first scan is emitted as "new". When false, the first scan only seeds the state and emits nothing. */
  emit_on_first_scan: z.boolean().default(false),
});
type Config = z.infer<typeof ConfigSchema>;

const plugin: Source = {
  name: 'source-immoscout24-sitemap',
  configSchema: ConfigSchema,
  async *fetch(ctx: Context) {
    const cfg = ctx.config as Config;
    const db = ctx.db as WabeDb;
    const leaves = await discoverRentLeaves(cfg.root_url, ctx.signal);
    const filtered = leaves.filter((url) => cfg.languages.some((lang) => url.includes(`-RENT-${lang}.xml.gz`)));
    const seen = loadSeenUrls(db);
    const newSeen = new Set(seen ?? []);
    for (const leafUrl of filtered) {
      if (ctx.signal.aborted) return;
      const entries = await fetchSitemapLeaf(leafUrl, ctx.signal);
      for (const e of entries) {
        if (!e.loc) continue;
        const isNew = !newSeen.has(e.loc);
        newSeen.add(e.loc);
        if (seen === null && !cfg.emit_on_first_scan) continue;
        if (!isNew) continue;
        const mapped = mapEntry(e);
        if (mapped) yield mapped;
      }
    }
    saveSeenUrls(db, newSeen);
  },
};

const exp: PluginExport = { kind: 'source', plugin };
export default exp;
