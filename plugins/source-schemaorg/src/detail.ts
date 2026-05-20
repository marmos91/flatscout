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

/**
 * Walks every JSON-LD block in the HTML, recursing into nested objects/arrays,
 * and returns the first node whose `@type` matches the listing family. Returns
 * null when no JSON-LD listing is present — callers should then fall back to
 * the Tier 2 extractor (`extractOpenGraph`).
 */
export function extractJsonLd(html: string): JsonLdListing | null {
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    const block = m[1];
    if (!block) continue;
    try {
      const obj = JSON.parse(block) as unknown;
      const hit = walk(obj);
      if (hit) return hit;
    } catch {
      // ignore malformed blocks
    }
  }
  return null;
}

function walk(obj: unknown): JsonLdListing | null {
  if (!obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const hit = walk(item);
      if (hit) return hit;
    }
    return null;
  }
  const rec = obj as Record<string, unknown>;
  const type = rec['@type'];
  if (typeof type === 'string' && TARGET_TYPES.has(type)) return rec as unknown as JsonLdListing;
  for (const v of Object.values(rec)) {
    const hit = walk(v);
    if (hit) return hit;
  }
  return null;
}
