import type { Logger } from 'pino';
import { HomegateAntiBotError, HomegateHttpError, HomegateParseError } from './errors.js';
import type { SearchBody } from './search.js';
import type { Transport } from './transport.js';

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
  paceMs: number;
  backoff: { on: number[]; retries: number; base_ms: number };
  signal: AbortSignal;
  logger: Logger;
  transport: Transport;
}

/**
 * Performs one `POST /search/listings` against the Homegate API using the
 * supplied `Transport`.
 *
 * Retries the configured backoff status codes with exponential backoff. On a
 * 403 the transport's `invalidateAndRetryOnce` hook is called; bridge
 * transports cannot refresh DataDome state from Node (the operator must
 * reload Homegate in their browser), so the hook returns false and the 403
 * surfaces as `HomegateAntiBotError`.
 */
export async function fetchSearch(body: SearchBody, ctx: FetchContext): Promise<SearchResponse> {
  const url = `${API_BASE}${SEARCH_PATH}`;
  const payload = JSON.stringify(body);
  let antibotRetryUsed = false;

  for (let attempt = 0; attempt <= ctx.backoff.retries; ) {
    if (ctx.signal.aborted) throw new Error('aborted');
    const res = await ctx.transport.request({
      method: 'POST',
      url,
      hasBody: true,
      body: payload,
      signal: ctx.signal,
      logger: ctx.logger,
    });
    if (res.status >= 200 && res.status < 300) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(res.body);
      } catch (err) {
        throw new HomegateParseError(`failed to parse homegate response: ${(err as Error).message}`);
      }
      if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as SearchResponse).results)) {
        throw new HomegateParseError('homegate response missing results[]');
      }
      return parsed as SearchResponse;
    }
    if (res.status === 403) {
      if (antibotRetryUsed) {
        throw new HomegateAntiBotError(url, res.body);
      }
      antibotRetryUsed = true;
      const retried = await ctx.transport.invalidateAndRetryOnce('403 anti-bot', ctx.logger);
      if (!retried) {
        throw new HomegateAntiBotError(url, res.body);
      }
      continue;
    }
    if (!ctx.backoff.on.includes(res.status) || attempt === ctx.backoff.retries) {
      throw new HomegateHttpError(res.status, url, res.body);
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
