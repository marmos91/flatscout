import { fetch } from 'undici';

export interface JsonLdListing {
  '@type':
    | 'RealEstateListing'
    | 'Apartment'
    | 'House'
    | 'Residence'
    | 'SingleFamilyResidence'
    | 'Accommodation'
    | 'Product';
  name?: string;
  description?: string;
  url?: string;
  image?: string | string[];
  numberOfRooms?: number | string;
  floorSize?: { value?: number | string };
  address?: { streetAddress?: string; postalCode?: string; addressLocality?: string; addressRegion?: string };
  geo?: { latitude?: number | string; longitude?: number | string };
  offers?: { price?: number | string; priceCurrency?: string };
  datePosted?: string;
}

export interface DetailPayload {
  html: string;
  status: number;
}

export async function fetchDetail(url: string, signal: AbortSignal): Promise<DetailPayload> {
  const res = await fetch(url, {
    signal,
    method: 'GET',
    redirect: 'follow',
    headers: {
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 wabe-schemaorg/1',
      accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
    },
  });
  const html = await res.text();
  if (res.status !== 200) throw new Error(`detail ${url} responded ${res.status}`);
  return { html, status: res.status };
}

const TARGET_TYPES = new Set([
  'RealEstateListing',
  'Apartment',
  'House',
  'Residence',
  'SingleFamilyResidence',
  'Accommodation',
]);

/** Best-anchor preference: RealEstateListing > Apartment > House > others. */
const ANCHOR_PRIORITY: Record<string, number> = {
  RealEstateListing: 0,
  Apartment: 1,
  House: 2,
  SingleFamilyResidence: 3,
  Residence: 4,
  Accommodation: 5,
};

/**
 * Walks every JSON-LD block in the HTML and returns the highest-priority
 * anchor node (RealEstateListing → Apartment → House → ...). Returns null
 * when no JSON-LD listing-family node is present.
 *
 * Use `collectJsonLdFacts` when you also need auxiliary nodes (Offer,
 * PostalAddress, GeoCoordinates, UnitPriceSpecification) for fact merging —
 * CasaWP and other graph-based JSON-LD producers split price into a separate
 * Offer / UnitPriceSpecification node referenced by `@id` from the anchor.
 */
export function extractJsonLd(html: string): JsonLdListing | null {
  return collectJsonLdFacts(html).anchor;
}

export interface JsonLdFacts {
  anchor: JsonLdListing | null;
  offers: Array<Record<string, unknown>>;
  priceSpecs: Array<Record<string, unknown>>;
  addresses: Array<Record<string, unknown>>;
  geos: Array<Record<string, unknown>>;
  /** All target-type nodes seen, in encounter order. The first one in `ANCHOR_PRIORITY` order becomes `anchor`. */
  anchorCandidates: Array<JsonLdListing & Record<string, unknown>>;
}

/**
 * Walk every JSON-LD block in the HTML and return all relevant typed nodes.
 * Anchors are deduplicated to the single best one per `ANCHOR_PRIORITY`. Used
 * by the unified extractor to merge a CasaWP-style split graph (anchor +
 * Offer + Apartment + UnitPriceSpec) into one logical listing.
 */
export function collectJsonLdFacts(html: string): JsonLdFacts {
  const facts: JsonLdFacts = {
    anchor: null,
    offers: [],
    priceSpecs: [],
    addresses: [],
    geos: [],
    anchorCandidates: [],
  };
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    const block = m[1];
    if (!block) continue;
    try {
      const obj = JSON.parse(block) as unknown;
      walkCollect(obj, facts);
    } catch {
      // ignore malformed blocks
    }
  }
  // Pick the highest-priority anchor among candidates.
  let best: (JsonLdListing & Record<string, unknown>) | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const c of facts.anchorCandidates) {
    const t = c['@type'];
    if (typeof t !== 'string') continue;
    const rank = ANCHOR_PRIORITY[t] ?? 99;
    if (rank < bestRank) {
      best = c;
      bestRank = rank;
    }
  }
  facts.anchor = best;
  return facts;
}

function walkCollect(obj: unknown, facts: JsonLdFacts): void {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (const item of obj) walkCollect(item, facts);
    return;
  }
  const rec = obj as Record<string, unknown>;
  const type = rec['@type'];
  if (typeof type === 'string') {
    if (TARGET_TYPES.has(type)) facts.anchorCandidates.push(rec as JsonLdListing & Record<string, unknown>);
    if (type === 'Offer') facts.offers.push(rec);
    if (type === 'UnitPriceSpecification' || type === 'PriceSpecification') facts.priceSpecs.push(rec);
    if (type === 'PostalAddress') facts.addresses.push(rec);
    if (type === 'GeoCoordinates') facts.geos.push(rec);
  }
  for (const v of Object.values(rec)) walkCollect(v, facts);
}
