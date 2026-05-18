import { Pool, type Dispatcher } from 'undici';
import { HomegateAuthError, HomegateBadResponse, HomegateRateLimit } from './errors.js';
import { type AuthCfg, appIdHeader, basicAuthHeader } from './auth.js';
import type { HomegateListing } from './map.js';
import { buildBody, type SearchConfig } from './search.js';

const HOST = 'https://api.homegate.ch';
const PATH = '/search/listings';

export interface FetchOptions {
  pool?: Dispatcher;
  auth: AuthCfg;
  paceMs: number;
  backoff: { on: number[]; retries: number; base_ms: number };
  signal: AbortSignal;
  now?: () => number;
}

export interface HomegatePage {
  results: { listing: HomegateListing }[];
  total: number;
}

export async function fetchPage(
  search: SearchConfig,
  page_size: number,
  offset: number,
  opts: FetchOptions,
): Promise<HomegatePage> {
  const pool = opts.pool ?? new Pool(HOST);
  const body = JSON.stringify(buildBody(search, page_size, offset));
  for (let attempt = 0; attempt <= opts.backoff.retries; attempt += 1) {
    const epoch = Math.floor((opts.now ?? Date.now)() / 1000);
    const headers = {
      authorization: basicAuthHeader(opts.auth),
      'x-app-id': appIdHeader(opts.auth, 'POST', PATH, epoch),
      'x-app-version': opts.auth.app_version,
      'user-agent': opts.auth.user_agent,
      'content-type': 'application/json',
      accept: 'application/json',
    };
    const res = await pool.request({
      method: 'POST',
      path: PATH,
      headers,
      body,
      signal: opts.signal,
    });
    if (res.statusCode === 401 || res.statusCode === 403) {
      throw new HomegateAuthError(`homegate auth ${res.statusCode}`);
    }
    if (res.statusCode >= 200 && res.statusCode < 300) {
      const json = (await res.body.json()) as HomegatePage;
      return json;
    }
    const bodyText = await res.body.text();
    if (res.statusCode === 429) {
      if (attempt === opts.backoff.retries) throw new HomegateRateLimit(bodyText);
    } else if (!opts.backoff.on.includes(res.statusCode) || attempt === opts.backoff.retries) {
      throw new HomegateBadResponse(`status ${res.statusCode}: ${bodyText.slice(0, 200)}`);
    }
    await sleep(opts.backoff.base_ms * 2 ** attempt, opts.signal);
  }
  throw new HomegateBadResponse('unreachable');
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
