import { z } from 'zod';

export const SearchConfig = z.object({
  zipcodes: z.array(z.number().int().min(1000).max(9999)).default([]),
  price_max: z.number().int().positive().optional(),
  price_min: z.number().int().positive().optional(),
  rooms_min: z.number().positive().optional(),
  rooms_max: z.number().positive().optional(),
  surface_min: z.number().int().positive().optional(),
  property_type: z.enum(['APARTMENT_OR_HOUSE', 'APARTMENT', 'HOUSE']).default('APARTMENT_OR_HOUSE'),
  offer_type: z.literal('RENT').default('RENT'),
  has_balcony: z.boolean().optional(),
  has_elevator: z.boolean().optional(),
  sort_by: z.enum(['dateCreated', 'price', 'roomCount', 'livingSpace']).default('dateCreated'),
  sort_direction: z.enum(['asc', 'desc']).default('desc'),
  language: z.enum(['de', 'fr', 'it', 'en']).default('en'),
});
export type SearchConfig = z.infer<typeof SearchConfig>;

const BASE = 'https://www.immoscout24.ch';

const PATH_PER_LANG: Record<SearchConfig['language'], string> = {
  en: '/en/real-estate/rent',
  de: '/de/immobilien/mieten',
  fr: '/fr/immobilier/louer',
  it: '/it/immobili/affittare',
};

const KNOWN_CITY_SLUGS: Record<number, string> = {
  8001: 'city-zurich',
  8002: 'city-zurich',
  8003: 'city-zurich',
  8004: 'city-zurich',
  8005: 'city-zurich',
  8006: 'city-zurich',
  8008: 'city-zurich',
  8032: 'city-zurich',
  1201: 'city-geneva',
  1202: 'city-geneva',
  1203: 'city-geneva',
  1204: 'city-geneva',
  4001: 'city-basel',
  4051: 'city-basel',
  4052: 'city-basel',
  4053: 'city-basel',
  4054: 'city-basel',
  3000: 'city-bern',
  3011: 'city-bern',
  3012: 'city-bern',
  3013: 'city-bern',
  3014: 'city-bern',
  6000: 'city-lucerne',
  6003: 'city-lucerne',
  6004: 'city-lucerne',
  6005: 'city-lucerne',
  9000: 'city-stgallen',
  9001: 'city-stgallen',
  9008: 'city-stgallen',
};

function resolveLocationSegment(zipcodes: readonly number[]): { pathSegment: string; wzip: string | null } {
  if (zipcodes.length === 0) return { pathSegment: '', wzip: null };
  if (zipcodes.length === 1) {
    const slug = KNOWN_CITY_SLUGS[zipcodes[0]!];
    if (slug) return { pathSegment: `/${slug}`, wzip: null };
    return { pathSegment: '', wzip: String(zipcodes[0]) };
  }
  // Multi-zip: collapse to single city slug when every zip resolves to it.
  // IS24's `/city-<slug>` route serves the SRP, while the wzip-only root path
  // returns a generic landing page without `__INITIAL_STATE__`.
  const slugs = zipcodes.map((z) => KNOWN_CITY_SLUGS[z]);
  const firstSlug = slugs[0];
  if (firstSlug && slugs.every((s) => s === firstSlug)) {
    return { pathSegment: `/${firstSlug}`, wzip: null };
  }
  return { pathSegment: '', wzip: zipcodes.join(',') };
}

export function buildSrpUrl(cfg: SearchConfig, page: number): string {
  const { pathSegment, wzip } = resolveLocationSegment(cfg.zipcodes);
  const url = new URL(`${BASE}${PATH_PER_LANG[cfg.language]}${pathSegment}`);
  url.searchParams.set('an', 'G');
  url.searchParams.set('pn', String(page));
  if (wzip !== null) url.searchParams.set('wzip', wzip);
  // Verified live (2026-05-20): `pf/pt` = price min/max, `nrf/nrt` = rooms
  // min/max, `slf` = surface min. The previous `ps/pe` guess was a no-op.
  if (cfg.price_min != null) url.searchParams.set('pf', String(cfg.price_min));
  if (cfg.price_max != null) url.searchParams.set('pt', String(cfg.price_max));
  if (cfg.rooms_min != null) url.searchParams.set('nrf', String(cfg.rooms_min));
  if (cfg.rooms_max != null) url.searchParams.set('nrt', String(cfg.rooms_max));
  if (cfg.surface_min != null) url.searchParams.set('slf', String(cfg.surface_min));
  // NOTE: `has_balcony`, `has_elevator`, `property_type`, and `sort_by` /
  // `sort_direction` are accepted by the config schema but NOT yet wired to
  // the URL. Live probes against IS24's SRP showed none of the obvious param
  // names (`bal`, `lif`, `elv`, `cat`, `co`, `ot`, `srt`, `sdt`, `se`, `so`,
  // `sort`) altered the response — these filters are likely set via
  // client-side JS state or a POST to api.immoscout24.ch. Until the wire
  // format is captured, emit nothing rather than ineffective params.
  return url.toString();
}
