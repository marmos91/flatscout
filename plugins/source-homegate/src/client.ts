import type { Logger } from 'pino';
import { HomegateAntiBotError, HomegateHttpError, HomegateParseError } from './errors.js';
import type { SearchBody } from './search.js';
import type { Transport } from './transport.js';

const API_BASE = 'https://api.homegate.ch';
const SEARCH_PATH = '/search/listings';

export interface SearchResult {
  id: string;
  listingType?: Record<string, unknown>;
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
 * Retries the configured backoff status codes with exponential backoff. A 403
 * is always treated as a DataDome block and surfaces as `HomegateAntiBotError`
 * — there is no Node-side recovery; the operator must reload Homegate in the
 * paired browser to refresh the session.
 */
export async function fetchSearch(body: SearchBody, ctx: FetchContext): Promise<SearchResponse> {
  const url = `${API_BASE}${SEARCH_PATH}`;
  const payload = JSON.stringify(body);

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
      throw new HomegateAntiBotError(url, res.body);
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
