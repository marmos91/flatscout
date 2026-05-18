import { request } from 'undici';

export interface JsonLdListing {
  '@type': 'RealEstateListing' | 'Apartment' | 'House' | 'Residence' | 'Product';
  name?: string;
  description?: string;
  url?: string;
  image?: string | string[];
  numberOfRooms?: number | string;
  floorSize?: { value?: number | string };
  address?: { streetAddress?: string; postalCode?: string; addressLocality?: string; addressRegion?: string };
  offers?: { price?: number | string; priceCurrency?: string };
  datePosted?: string;
}

export interface DetailPayload {
  listing: JsonLdListing | null;
}

export async function fetchDetail(url: string, signal: AbortSignal): Promise<DetailPayload> {
  const res = await request(url, {
    signal,
    method: 'GET',
    headers: { 'user-agent': 'Mozilla/5.0 wabe/0', accept: 'text/html' },
  });
  if (res.statusCode !== 200) throw new Error(`detail ${url} responded ${res.statusCode}`);
  return extractJsonLd(await res.body.text());
}

const TARGET_TYPES = new Set(['RealEstateListing', 'Apartment', 'House', 'Residence']);

export function extractJsonLd(html: string): DetailPayload {
  const out: DetailPayload = { listing: null };
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    const block = m[1];
    if (!block) continue;
    try {
      const obj = JSON.parse(block) as unknown;
      collect(obj, out);
    } catch {
      // ignore malformed blocks
    }
    if (out.listing) break; // first hit wins
  }
  return out;
}

function collect(obj: unknown, out: DetailPayload): void {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (const item of obj) collect(item, out);
    return;
  }
  const type = (obj as { '@type'?: string })['@type'];
  if (type && TARGET_TYPES.has(type)) out.listing = obj as JsonLdListing;
  for (const v of Object.values(obj as Record<string, unknown>)) collect(v, out);
}
