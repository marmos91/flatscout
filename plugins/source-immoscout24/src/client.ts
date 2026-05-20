import type { Logger } from 'pino';
import { IS24AntiBotError, IS24HttpError } from './errors.js';
import type { Transport } from './transport.js';

export interface FetchContext {
  paceMs: number;
  backoff: { on: number[]; retries: number; base_ms: number };
  signal: AbortSignal;
  logger: Logger;
  transport: Transport;
  /** Optional Accept header override; defaults to HTML inside the transport. */
  accept?: string;
}

export interface FetchSrpResponse {
  status: number;
  body: string;
}

/**
 * GETs an IS24 SRP URL through the bridge transport. Retries the configured
 * status codes with exponential backoff. 403 always surfaces as
 * `IS24AntiBotError` — DataDome binds its cookie to the user's real browser
 * session, so there is no Node-side recovery; the operator must reload an
 * IS24 page in the paired browser to refresh the session.
 */
export async function fetchSrp(url: string, ctx: FetchContext): Promise<FetchSrpResponse> {
  for (let attempt = 0; attempt <= ctx.backoff.retries; ) {
    if (ctx.signal.aborted) throw new Error('aborted');
    const res = await ctx.transport.request({
      method: 'GET',
      url,
      signal: ctx.signal,
      logger: ctx.logger,
      accept: ctx.accept,
    });
    if (res.status >= 200 && res.status < 300) {
      return { status: res.status, body: res.body };
    }
    if (res.status === 403) {
      throw new IS24AntiBotError(url, res.body);
    }
    if (!ctx.backoff.on.includes(res.status) || attempt === ctx.backoff.retries) {
      throw new IS24HttpError(res.status, url, res.body);
    }
    await sleep(ctx.backoff.base_ms * 2 ** attempt, ctx.signal);
    attempt += 1;
  }
  throw new IS24HttpError(0, url, 'unreachable');
}

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
