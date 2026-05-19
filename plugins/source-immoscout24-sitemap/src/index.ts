import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { PluginExport, Source, Context } from '@wabe/plugin-sdk';
import type { WabeDb } from '@wabe/db';
import {
  BrowserBridgeTransport,
  DaemonBridgeTransport,
  getCurrentBridge,
  type Transport,
} from '@wabe/browser-bridge';
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
   * When true and the browser bridge is connected (in-process or via daemon),
   * fetch each new PDP HTML through the extension and emit full-detail listings
   * (rooms / price / description / photos). Otherwise emit URL-only listings.
   */
  enrich_via_bridge: z.boolean().default(true),
  /** Max PDPs to fetch per scan when bridge enrichment is on. Protects against floods on the first scan. */
  max_detail_per_scan: z.number().int().positive().default(40),
});
type Config = z.infer<typeof ConfigSchema>;

/**
 * Resolves the data directory the plugin should look in for the daemon bridge
 * heartbeat / secret. Mirrors `@wabe/cli`'s `resolvePaths` precedence.
 */
function resolveDataDir(): string {
  if (process.env.WABE_DATA_DIR) return process.env.WABE_DATA_DIR;
  const xdgData = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  return join(xdgData, 'wabe');
}

type TransportKind = 'bridge-inproc' | 'bridge-daemon';

interface SelectedTransport {
  transport: Transport;
  kind: TransportKind;
  /** Optional cleanup (set for daemon-backed transport). */
  close?: () => Promise<void>;
}

/**
 * Tries to pick a bridge transport for PDP enrichment:
 *   1. In-process bridge (running inside `wabe start`).
 *   2. Daemon bridge via `${dataDir}/bridge.status.json` (sibling CLI process).
 *
 * Returns `null` if no bridge is available. Unlike source-homegate, this plugin
 * gracefully degrades to URL-only emission when no bridge is reachable, because
 * sitemap discovery itself doesn't require the bridge.
 */
async function selectBridgeTransport(dataDir: string): Promise<SelectedTransport | null> {
  const local = getCurrentBridge();
  if (local) {
    return { transport: new BrowserBridgeTransport(local), kind: 'bridge-inproc' };
  }
  const daemon = await DaemonBridgeTransport.tryConnect(dataDir);
  if (daemon) {
    return {
      transport: daemon,
      kind: 'bridge-daemon',
      close: async () => {
        await daemon.close();
      },
    };
  }
  return null;
}

let activeSelected: SelectedTransport | undefined;

const plugin: Source = {
  name: 'source-immoscout24-sitemap',
  configSchema: ConfigSchema,
  async *fetch(ctx: Context) {
    const cfg = ctx.config as Config;
    const db = ctx.db as WabeDb;
    const dataDir = resolveDataDir();
    const leaves = await discoverRentLeaves(cfg.root_url, ctx.signal);
    const filtered = leaves.filter((url) =>
      cfg.languages.some((lang) => url.includes(`-RENT-${lang}.xml.gz`)),
    );
    const seen = loadSeenUrls(db);
    const newSeen = new Set(seen ?? []);

    const selected = cfg.enrich_via_bridge ? await selectBridgeTransport(dataDir) : null;
    activeSelected = selected ?? undefined;
    const transport = selected?.transport ?? null;
    let detailFetched = 0;

    if (cfg.enrich_via_bridge && !selected) {
      ctx.logger.warn('immoscout24: enrich_via_bridge=true but no bridge available; emitting URL-only');
    } else if (selected) {
      ctx.logger.info({ kind: selected.kind }, 'immoscout24: enriching via browser bridge');
    }

    try {
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
    } finally {
      // CLOSE GUARANTEE: each fetch invocation closes its own selected
      // transport, even if a concurrent invocation reassigned `activeSelected`.
      // The module singleton is only retained so `dispose()` can act as a
      // safety net on abrupt shutdown.
      if (activeSelected === selected) activeSelected = undefined;
      if (selected?.close) {
        await selected.close();
      }
    }
  },
  async dispose() {
    if (activeSelected?.close) {
      await activeSelected.close();
    }
    activeSelected = undefined;
  },
};

const exp: PluginExport = { kind: 'source', plugin };
export default exp;
