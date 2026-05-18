import { createHash } from 'node:crypto';

/** Bucket rooms to nearest 0.5; pass-through null. */
export function roundRoomsBucket(rooms: number | null): number | null {
  if (rooms === null) return null;
  return Math.round(rooms * 2) / 2;
}

/** Bucket area to nearest 5 m²; pass-through null. */
export function roundAreaBucket(area: number | null): number | null {
  if (area === null) return null;
  return Math.round(area / 5) * 5;
}

/** Bucket price to nearest 50 CHF; pass-through null. */
export function roundPriceBucket(price: number | null): number | null {
  if (price === null) return null;
  return Math.round(price / 50) * 50;
}

export interface CanonicalKeyInput {
  postal_code: string | null;
  rooms: number | null;
  area_m2: number | null;
  price_total: number | null;
  /** Used to make the key unique when any bucket field is missing, so partial listings never collapse onto detailed ones. */
  url: string;
}

/**
 * Returns a deterministic sha256 key over bucketed dedup fields.
 *
 * When all four bucket fields (postal_code, rooms, area, price) are present,
 * the key collapses listings whose values round to the same buckets. If any
 * field is missing, the key includes the URL so the listing stays unique —
 * accepted trade: false negatives over false positives.
 */
export function canonicalKey(input: CanonicalKeyInput): string {
  const rb = roundRoomsBucket(input.rooms);
  const ab = roundAreaBucket(input.area_m2);
  const pb = roundPriceBucket(input.price_total);
  const allBucketsPresent = input.postal_code !== null && rb !== null && ab !== null && pb !== null;
  const material = allBucketsPresent ? `${input.postal_code}|${rb}|${ab}|${pb}` : `url:${input.url}`;
  return createHash('sha256').update(material).digest('hex');
}

/**
 * Default source priorities (0-100, higher wins on dedup tie).
 * Overridable per source via `sources[].priority` in user yaml.
 * Plugins not listed here default to 50.
 */
export const SOURCE_PRIORITY_DEFAULTS: Record<string, number> = {
  agency: 100,
  'source-flatfox': 80,
  'source-homegate': 70,
  'source-immoscout24-sitemap': 70,
  'source-immobilier-ch': 70,
  'source-schemaorg': 70,
  'source-realadvisor': 50,
  'source-engelvoelkers': 30,
  'source-housinganywhere': 30,
};

export const DEFAULT_SOURCE_PRIORITY = 50;
