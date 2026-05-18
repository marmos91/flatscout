import type { Logger } from 'pino';
import { bootstrapSite, type BootstrapResult } from '@wabe/browser-runtime';
import { isCookieFresh, loadCookies, saveCookies } from './cookies.js';

export interface EnsureBootstrapOptions {
  /** Force a fresh bootstrap even if a cached cookie file is present and fresh. */
  force?: boolean;
  /** Override cookie freshness window (ms). Defaults to the cookies module default (12h). */
  maxAgeMs?: number;
}

/**
 * Module-level lock map keyed by `dataDir` so concurrent callers within the
 * same process share a single in-flight bootstrap instead of spawning two
 * headless browsers.
 */
const inflight = new Map<string, Promise<BootstrapResult>>();

/**
 * Loads cached cookies from `dataDir` and reuses them if they are still
 * fresh (and `force` is not set). Otherwise launches the stealth browser via
 * `bootstrapSite` against `https://www.homegate.ch/rent`, persists the result,
 * and returns it.
 */
export async function ensureBootstrap(
  dataDir: string,
  logger: Logger,
  opts: EnsureBootstrapOptions = {},
): Promise<BootstrapResult> {
  if (!opts.force) {
    const cached = await loadCookies(dataDir);
    if (cached && isCookieFresh(cached, opts.maxAgeMs)) {
      logger.debug({ capturedAt: cached.capturedAt }, 'reusing cached homegate cookies');
      return cached;
    }
  }
  const existing = inflight.get(dataDir);
  if (existing) return existing;
  const pending = (async () => {
    logger.info({ force: opts.force ?? false }, 'bootstrapping homegate cookies via stealth browser');
    const result = await bootstrapSite({
      target: 'https://www.homegate.ch/rent',
      waitFor: 'body',
      timeoutMs: 45_000,
      logger,
    });
    await saveCookies(dataDir, result);
    logger.info({ cookieCount: result.cookies.length }, 'homegate cookies persisted');
    return result;
  })().finally(() => {
    inflight.delete(dataDir);
  });
  inflight.set(dataDir, pending);
  return pending;
}
