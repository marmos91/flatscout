import { Pool, type Dispatcher } from 'undici';
import { FlatfoxHttpError } from './errors.js';
import type { FlatfoxApiResult } from './map.js';
import { buildQuery, type SearchConfig } from './search.js';

const HOST = 'https://flatfox.ch';

export interface FetchOptions {
  pool?: Dispatcher;
  paceMs: number;
  backoff: { on: number[]; retries: number; base_ms: number };
  signal: AbortSignal;
}

export interface FlatfoxPage {
  results: FlatfoxApiResult[];
  next: string | null;
}

export async function fetchPage(
  search: SearchConfig,
  limit: number,
  offset: number,
  opts: FetchOptions,
): Promise<FlatfoxPage> {
  const url = `${HOST}/api/v1/public-listing/?${buildQuery(search, limit, offset)}`;
  const pool = opts.pool ?? new Pool(HOST);
  for (let attempt = 0; attempt <= opts.backoff.retries; attempt += 1) {
    const res = await pool.request({
      method: 'GET',
      path: url.replace(HOST, ''),
      signal: opts.signal,
      headers: { accept: 'application/json' },
    });
    if (res.statusCode >= 200 && res.statusCode < 300) {
      const body = (await res.body.json()) as { results: FlatfoxApiResult[]; next: string | null };
      return { results: body.results ?? [], next: body.next ?? null };
    }
    const bodyText = await res.body.text();
    if (!opts.backoff.on.includes(res.statusCode) || attempt === opts.backoff.retries) {
      throw new FlatfoxHttpError(res.statusCode, url, bodyText);
    }
    await sleep(opts.backoff.base_ms * 2 ** attempt, opts.signal);
  }
  throw new FlatfoxHttpError(0, url, 'unreachable');
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    }, { once: true });
  });
}
