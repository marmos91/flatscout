import { request } from 'undici';

export interface JsonLdProduct {
  '@type': 'Product';
  name?: string;
  description?: string;
  offers?: { price?: number | string; priceCurrency?: string };
  image?: string | string[];
}

export interface JsonLdResidence {
  '@type': 'Residence';
  address?: { streetAddress?: string; postalCode?: string; addressLocality?: string };
  numberOfRooms?: number | string;
  floorSize?: { value?: number | string };
}

export interface DetailPayload {
  product: JsonLdProduct | null;
  residence: JsonLdResidence | null;
}

export async function fetchDetail(url: string, signal: AbortSignal): Promise<DetailPayload> {
  const res = await request(url, {
    signal,
    method: 'GET',
    headers: { 'user-agent': 'Mozilla/5.0 wabe/0', accept: 'text/html' },
  });
  if (res.statusCode !== 200) throw new Error(`detail ${url} responded ${res.statusCode}`);
  const html = await res.body.text();
  return extractJsonLd(html);
}

export function extractJsonLd(html: string): DetailPayload {
  const out: DetailPayload = { product: null, residence: null };
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
  if (type === 'Product') out.product = obj as JsonLdProduct;
  if (type === 'Residence') out.residence = obj as JsonLdResidence;
  // walk nested values
  for (const v of Object.values(obj as Record<string, unknown>)) collect(v, out);
}
