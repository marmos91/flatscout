import { request } from 'undici';
import { buildSearchParams, type SearchConfig } from './search.js';

export interface BackoffPolicy {
  on: number[];
  retries: number;
  base_ms: number;
}

export interface ClientOpts {
  paceMs: number;
  backoff: BackoffPolicy;
  signal: AbortSignal;
}

export interface RawHit {
  id: string;
  url?: string;
  clickout_url?: { hostname?: string; pathname?: string };
  rooms?: number | null;
  surface_livable?: number | null;
  price?: { value?: number | null; currency?: string | null } | null;
  postal_code?: string | null;
  locality?: string | null;
  canton?: string | null;
  created_at?: string | null;
}

export interface RealAdvisorPage {
  total_count: number;
  hits: RawHit[];
}

export async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    });
  });
}

export async function fetchPage(cfg: SearchConfig, page: number, opts: ClientOpts): Promise<RealAdvisorPage> {
  const url = `https://realadvisor.ch/api/listings?${buildSearchParams(cfg, page).toString()}`;
  let attempt = 0;
  // simple retry-on-backoff loop
  while (true) {
    const res = await request(url, { signal: opts.signal, method: 'GET', headers: { accept: 'application/json' } });
    if (res.statusCode >= 200 && res.statusCode < 300) {
      const body = (await res.body.json()) as RealAdvisorPage;
      return body;
    }
    if (opts.backoff.on.includes(res.statusCode) && attempt < opts.backoff.retries) {
      const delay = opts.backoff.base_ms * 2 ** attempt;
      attempt += 1;
      await sleep(delay, opts.signal);
      continue;
    }
    throw new Error(`realadvisor /api/listings page ${page} responded ${res.statusCode}`);
  }
}
