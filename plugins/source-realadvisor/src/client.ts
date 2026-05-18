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

/**
 * Subset of the realadvisor `/api/listings` listing shape that this plugin
 * consumes. The live API returns many more fields (agency, bullet points,
 * images, …) which we intentionally ignore.
 */
export interface RawHit {
  id: number | string;
  portal?: string | null;
  title?: string | null;
  description?: string | null;
  clickout_url?: { hostname?: string | null; url?: string | null } | null;
  offer_type?: string | null;
  property_main_type?: string | null;
  property_type?: string | null;
  number_of_rooms?: number | null;
  living_surface?: number | null;
  usable_surface?: number | null;
  computed_surface?: number | null;
  gross_rent_monthly?: number | null;
  rent_net_monthly?: number | null;
  rent_extra?: number | null;
  sale_price?: number | null;
  currency?: string | null;
  address?: string | null;
  route?: string | null;
  street_number?: string | null;
  postcode?: string | null;
  locality?: string | null;
  sub_locality?: string | null;
  state?: string | null;
  lat?: number | null;
  lng?: number | null;
  construction_year?: number | null;
  renovation_year?: number | null;
  created_at?: string | null;
  agency_name?: string | null;
  agency_contact_phone_number?: string | null;
}

export interface RealAdvisorPage {
  total_count: number;
  listings: RawHit[];
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
    const res = await request(url, {
      signal: opts.signal,
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    if (res.statusCode >= 200 && res.statusCode < 300) {
      const body = (await res.body.json()) as RealAdvisorPage;
      return { total_count: body.total_count ?? 0, listings: body.listings ?? [] };
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
