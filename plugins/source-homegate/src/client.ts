import type { Logger } from 'pino';
import { request } from 'undici';
import { ensureBootstrap as defaultEnsureBootstrap } from './bootstrap.js';
import { deleteCookies } from './cookies.js';
import { HomegateAntiBotError, HomegateHttpError, HomegateParseError } from './errors.js';
import { buildHeaders } from './headers.js';
import type { SearchBody } from './search.js';

const API_BASE = 'https://api.homegate.ch';
const SEARCH_PATH = '/search/listings';

export interface SearchResult {
  id: string;
  listingType?: string;
  listing: unknown;
}

export interface SearchResponse {
  from: number;
  size: number;
  total: number;
  results: SearchResult[];
  maxFrom?: number;
}

export interface FetchContext {
  dataDir: string;
  paceMs: number;
  backoff: { on: number[]; retries: number; base_ms: number };
  signal: AbortSignal;
  logger: Logger;
  /** Cookie freshness window in ms. Defaults to the cookies module default (12h). */
  cookieMaxAgeMs?: number;
  /** Optional bearer accessor (Phase 3 will wire this; Phase 2 leaves it null). */
  getBearer?: () => Promise<string | null>;
  /** Injectable for tests; defaults to the real `ensureBootstrap`. */
  ensureBootstrap?: typeof defaultEnsureBootstrap;
}

/**
 * Performs one `POST /search/listings` against the Homegate API with the
 * captured iOS-app header set.
 *
 * Retries the configured backoff status codes with exponential backoff. On a
 * 403, treats it as a DataDome challenge: deletes the cached cookie file,
 * forces a re-bootstrap once, and retries with fresh cookies. A second 403
 * raises `HomegateAntiBotError`.
 */
export async function fetchSearch(body: SearchBody, ctx: FetchContext): Promise<SearchResponse> {
  const ensure = ctx.ensureBootstrap ?? defaultEnsureBootstrap;
  const url = `${API_BASE}${SEARCH_PATH}`;
  const bearer = ctx.getBearer ? await ctx.getBearer() : null;

  let cookies = await ensure(ctx.dataDir, ctx.logger, { maxAgeMs: ctx.cookieMaxAgeMs });
  let antibotRetryUsed = false;

  for (let attempt = 0; attempt <= ctx.backoff.retries; ) {
    if (ctx.signal.aborted) throw new Error('aborted');
    const headers = buildHeaders({
      cookie: cookies.cookieHeader,
      userAgent: cookies.userAgent,
      bearer,
      hasBody: true,
    });
    const res = await request(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctx.signal,
    });
    if (res.statusCode >= 200 && res.statusCode < 300) {
      let parsed: unknown;
      try {
        parsed = await res.body.json();
      } catch (err) {
        throw new HomegateParseError(`failed to parse homegate response: ${(err as Error).message}`);
      }
      if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as SearchResponse).results)) {
        throw new HomegateParseError('homegate response missing results[]');
      }
      return parsed as SearchResponse;
    }
    const bodyText = await res.body.text();
    if (res.statusCode === 403) {
      if (antibotRetryUsed) {
        throw new HomegateAntiBotError(url, bodyText);
      }
      antibotRetryUsed = true;
      ctx.logger.warn({ status: 403 }, 'homegate 403; invalidating cookies and re-bootstrapping');
      await deleteCookies(ctx.dataDir);
      cookies = await ensure(ctx.dataDir, ctx.logger, {
        force: true,
        maxAgeMs: ctx.cookieMaxAgeMs,
      });
      continue;
    }
    if (!ctx.backoff.on.includes(res.statusCode) || attempt === ctx.backoff.retries) {
      throw new HomegateHttpError(res.statusCode, url, bodyText);
    }
    await sleep(ctx.backoff.base_ms * 2 ** attempt, ctx.signal);
    attempt += 1;
  }
  throw new HomegateHttpError(0, url, 'unreachable');
}

/** Promise-based sleep that rejects with `Error('aborted')` when `signal` aborts before the timeout. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}
