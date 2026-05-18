/**
 * JSON-LD extractor for ImmoScout24 PDP HTML. Same shape as
 * `@wabe/source-schemaorg/dist/detail.js`'s `extractJsonLd`; copied + adapted
 * so this plugin doesn't grow a runtime dep on schemaorg.
 *
 * Falls back to extracting Next.js `__NEXT_DATA__` SSR JSON when no JSON-LD
 * `RealEstateListing` block is found.
 */

export interface JsonLdListing {
  '@type'?: string;
  name?: string;
  description?: string;
  url?: string;
  image?: string | string[];
  numberOfRooms?: number | string;
  floorSize?: { value?: number | string };
  address?: {
    streetAddress?: string;
    postalCode?: string;
    addressLocality?: string;
    addressRegion?: string;
  };
  offers?: { price?: number | string; priceCurrency?: string };
  datePosted?: string;
}

export interface DetailPayload {
  listing: JsonLdListing | null;
}

const TARGET_TYPES = new Set(['RealEstateListing', 'Apartment', 'House', 'Residence']);

export function extractDetail(html: string): DetailPayload {
  const ld = extractJsonLd(html);
  if (ld.listing) return ld;
  return extractNextData(html);
}

function extractJsonLd(html: string): DetailPayload {
  const out: DetailPayload = { listing: null };
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    const block = m[1];
    if (!block) continue;
    try {
      collect(JSON.parse(block) as unknown, out);
    } catch {
      // ignore malformed blocks
    }
    if (out.listing) break;
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

/**
 * IS24 ships its listing detail SSR via a `__NEXT_DATA__` blob. When JSON-LD is
 * missing or stripped we fall back to fishing out a few common fields.
 *
 * Robust enough for happy-path extraction; structural changes to the Next.js
 * page should be caught by integration tests rather than this regex.
 */
function extractNextData(html: string): DetailPayload {
  const m = html.match(
    /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/,
  );
  if (!m?.[1]) return { listing: null };
  try {
    const blob = JSON.parse(m[1]) as { props?: { pageProps?: Record<string, unknown> } };
    const pageProps = blob.props?.pageProps;
    if (!pageProps) return { listing: null };
    // IS24 ships listing details under various keys; scan props for an object
    // that looks like a property record.
    const found = findListingShape(pageProps);
    if (!found) return { listing: null };
    return { listing: shapeListing(found) };
  } catch {
    return { listing: null };
  }
}

function findListingShape(node: unknown): Record<string, unknown> | null {
  if (!node || typeof node !== 'object') return null;
  const r = node as Record<string, unknown>;
  if (
    typeof r.numberOfRooms === 'number' ||
    typeof r.rooms === 'number' ||
    typeof r.priceUnformatted === 'number' ||
    (typeof r.grossPrice === 'number' && typeof r.surfaceLiving === 'number')
  ) {
    return r;
  }
  for (const v of Object.values(r)) {
    const inner = findListingShape(v);
    if (inner) return inner;
  }
  return null;
}

function shapeListing(r: Record<string, unknown>): JsonLdListing {
  const rooms = (r.numberOfRooms ?? r.rooms) as number | undefined;
  const area = (r.surfaceLiving ?? r.floorSize) as number | undefined;
  const price = (r.grossPrice ?? r.priceUnformatted ?? r.netPrice) as number | undefined;
  return {
    '@type': 'RealEstateListing',
    name: typeof r.title === 'string' ? r.title : undefined,
    description: typeof r.description === 'string' ? r.description : undefined,
    numberOfRooms: rooms,
    floorSize: area !== undefined ? { value: area } : undefined,
    offers: price !== undefined ? { price, priceCurrency: 'CHF' } : undefined,
    address: shapeAddress(r),
    image: shapeImage(r),
  };
}

function shapeAddress(r: Record<string, unknown>): JsonLdListing['address'] {
  const street = pickStr(r, ['street', 'streetAddress']);
  const postalCode = pickStr(r, ['zip', 'postalCode']);
  const locality = pickStr(r, ['city', 'locality', 'addressLocality']);
  const region = pickStr(r, ['canton', 'addressRegion', 'state']);
  if (!street && !postalCode && !locality && !region) return undefined;
  const out: NonNullable<JsonLdListing['address']> = {};
  if (street) out.streetAddress = street;
  if (postalCode) out.postalCode = postalCode;
  if (locality) out.addressLocality = locality;
  if (region) out.addressRegion = region;
  return out;
}

function shapeImage(r: Record<string, unknown>): JsonLdListing['image'] {
  const imgs = r.images ?? r.photos ?? r.pictures;
  if (Array.isArray(imgs)) {
    const urls = imgs
      .map((i) => (typeof i === 'string' ? i : ((i as Record<string, unknown>)?.url as string | undefined)))
      .filter((u): u is string => typeof u === 'string');
    if (urls.length > 0) return urls;
  }
  return undefined;
}

function pickStr(r: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = r[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}
