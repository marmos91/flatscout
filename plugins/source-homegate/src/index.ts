import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { Context, PluginExport, Source } from '@wabe/plugin-sdk';
import { fetchSearch, sleep } from './client.js';
import { mapHomegateResult, HomegateApiSchema } from './map.js';
import { buildSearchBody, SearchConfig } from './search.js';

const FetchConfig = z.object({
  page_size: z.number().int().positive().max(50).default(20),
  max_pages: z.number().int().positive().default(5),
  pace_ms: z.number().int().nonnegative().default(2500),
  cookie_max_age_hours: z.number().positive().default(12),
  backoff: z
    .object({
      on: z.array(z.number()).default([429, 500, 502, 503, 504]),
      retries: z.number().int().nonnegative().default(3),
      base_ms: z.number().int().positive().default(2000),
    })
    .default({}),
});

const ConfigSchema = z.object({
  schedule: z.string().default('*/5 * * * *'),
  search: SearchConfig.default({}),
  fetch: FetchConfig.default({}),
});
type Config = z.infer<typeof ConfigSchema>;

/**
 * Resolves the data directory the plugin should persist its install identity,
 * cookies, and secrets into. Prefers `$WABE_DATA_DIR`, then `$XDG_DATA_HOME`,
 * then the platform default — matching `@wabe/cli`'s `resolvePaths`.
 */
function resolveDataDir(): string {
  if (process.env.WABE_DATA_DIR) return process.env.WABE_DATA_DIR;
  const xdgData = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  return join(xdgData, 'wabe');
}

/**
 * Homegate source plugin: paginates the iOS-style anonymous search endpoint,
 * driving fresh DataDome cookies through `@wabe/browser-runtime` on first
 * call and refreshing them automatically on 403.
 */
const plugin: Source = {
  name: 'source-homegate',
  configSchema: ConfigSchema,
  async *fetch(ctx: Context) {
    const cfg = ctx.config as Config;
    const dataDir = resolveDataDir();

    const cookieMaxAgeMs = cfg.fetch.cookie_max_age_hours * 3600_000;

    for (let page = 0; page < cfg.fetch.max_pages; page += 1) {
      if (ctx.signal.aborted) return;
      const from = page * cfg.fetch.page_size;
      const body = buildSearchBody(cfg.search, cfg.fetch.page_size, from);
      const res = await fetchSearch(body, {
        dataDir,
        paceMs: cfg.fetch.pace_ms,
        backoff: cfg.fetch.backoff,
        cookieMaxAgeMs,
        signal: ctx.signal,
        logger: ctx.logger,
        // Phase 3: getBearer will be wired to auth.getAccessToken; search is anonymous in Phase 2.
      });

      for (const raw of res.results) {
        const parsed = HomegateApiSchema.safeParse(raw);
        if (!parsed.success) {
          ctx.logger.warn(
            { err: parsed.error.message, listing_id: (raw as { id?: string }).id },
            'skipping malformed homegate result',
          );
          continue;
        }
        yield mapHomegateResult(parsed.data);
      }

      // Stop on last page / empty page / explicit cap.
      const next = from + res.results.length;
      if (res.results.length < cfg.fetch.page_size) break;
      if (next >= res.total) break;
      if (res.maxFrom != null && next >= res.maxFrom) break;
      if (page + 1 < cfg.fetch.max_pages) await sleep(cfg.fetch.pace_ms, ctx.signal);
    }
  },
};

/**
 * Public named exports for HG clients (e.g. `@wabe/cli`'s login/logout). The
 * plugin is the canonical source of truth for the OAuth2 wire shape; clients
 * import these instead of duplicating the literals.
 */
export { AUDIENCE, AUTH_BASE, CLIENT_ID, REDIRECT_URI, SCOPE } from './constants.js';
export { resolveDataDir };
export { saveCookies, loadCookies, isCookieFresh } from './cookies.js';

const exp: PluginExport = { kind: 'source', plugin };
export default exp;
