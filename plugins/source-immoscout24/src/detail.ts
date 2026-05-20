/**
 * IS24 PDP HTML detail extractor.
 *
 * IS24 PDPs ship their data via `window.__PINIA_INITIAL_STATE__` (Vue/Pinia
 * SSR hydration). The same `listing.lister` shape used by homegate's full
 * projection lives at `state.listing.listing.lister`. We pull contact-relevant
 * fields out of it and shape them so `enrich.ts` can merge them into a
 * SRP-derived RawListing without further translation.
 *
 * Fallbacks:
 * - JSON-LD `RealEstateListing` block (`datePosted` only in practice).
 * - Legacy Next.js `__NEXT_DATA__` heuristic (kept for older renders).
 */

export interface ListerContacts {
  phone?: string;
  email?: string;
  givenName?: string;
  familyName?: string;
}

export interface Provider {
  name?: string;
  url?: string;
}

/**
 * Shape exposed to enrich.ts. Field names match what `enrich.ts` reads on the
 * union type — `pl.contact?.{phone,email,form_url}`, `pl.telephone`,
 * `pl.email`, `pl.provider?.{name,url}`, plus a few JSON-LD-style fallbacks.
 */
export interface DetailListing {
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
  // PDP-enrichment-specific contact channels.
  contact?: { phone?: string; email?: string; form_url?: string };
  telephone?: string;
  email?: string;
  provider?: Provider;
  inquiry_contact?: string;
  viewing_contact?: string;
}

/** Back-compat alias — the legacy name some callers may still import. */
export type JsonLdListing = DetailListing;

export interface DetailPayload {
  listing: DetailListing | null;
}

const TARGET_TYPES = new Set(['RealEstateListing', 'Apartment', 'House', 'Residence']);

export function extractDetail(html: string): DetailPayload {
  const pinia = extractPiniaState(html);
  if (pinia.listing) return pinia;
  const ld = extractJsonLd(html);
  if (ld.listing) return ld;
  return extractNextData(html);
}

/**
 * Pulls `window.__PINIA_INITIAL_STATE__` out of the PDP and shapes the
 * embedded `listing.listing.lister` block (same convention as homegate's
 * search response) into contact-relevant fields.
 */
function extractPiniaState(html: string): DetailPayload {
  const m = html.match(/window\.__PINIA_INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/);
  if (!m?.[1]) return { listing: null };
  let blob: unknown;
  try {
    blob = JSON.parse(m[1]);
  } catch {
    return { listing: null };
  }
  type PiniaShape = {
    listing?: { listing?: { lister?: ListerObject; address?: Record<string, unknown>; meta?: { createdAt?: string } } };
  };
  const root = blob as PiniaShape;
  const lst = root.listing?.listing;
  if (!lst?.lister) return { listing: null };
  const out: DetailListing = { '@type': 'RealEstateListing' };
  applyLister(out, lst.lister);
  if (lst.meta?.createdAt) out.datePosted = lst.meta.createdAt;
  return { listing: out };
}

interface ListerObject {
  id?: string;
  legalName?: string;
  phone?: string;
  logoUrl?: string;
  website?: { value?: string } | string;
  contacts?: {
    inquiry?: ListerContacts;
    viewing?: ListerContacts;
  };
}

function applyLister(out: DetailListing, lister: ListerObject): void {
  const inquiry = lister.contacts?.inquiry;
  const viewing = lister.contacts?.viewing;
  const phone = inquiry?.phone ?? lister.phone ?? viewing?.phone;
  const email = inquiry?.email ?? viewing?.email;
  if (phone) {
    out.contact = { ...(out.contact ?? {}), phone };
    out.telephone = phone;
  }
  if (email) {
    out.contact = { ...(out.contact ?? {}), email };
    out.email = email;
  }
  const websiteUrl =
    typeof lister.website === 'string'
      ? lister.website
      : (lister.website?.value ?? undefined);
  if (lister.legalName || websiteUrl) {
    out.provider = {};
    if (lister.legalName) out.provider.name = lister.legalName;
    if (websiteUrl) out.provider.url = websiteUrl;
  }
  const inquiryName = [inquiry?.givenName, inquiry?.familyName].filter(Boolean).join(' ').trim();
  const viewingName = [viewing?.givenName, viewing?.familyName].filter(Boolean).join(' ').trim();
  if (inquiryName) out.inquiry_contact = inquiryName;
  if (viewingName && viewingName !== inquiryName) out.viewing_contact = viewingName;
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
  if (type && TARGET_TYPES.has(type)) out.listing = obj as DetailListing;
  for (const v of Object.values(obj as Record<string, unknown>)) collect(v, out);
}

/**
 * Legacy Next.js `__NEXT_DATA__` fallback — older IS24 renders shipped the
 * detail under Next.js SSR. Kept for resilience even though current pages use
 * Pinia state instead.
 */
function extractNextData(html: string): DetailPayload {
  const m = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/);
  if (!m?.[1]) return { listing: null };
  try {
    const blob = JSON.parse(m[1]) as { props?: { pageProps?: Record<string, unknown> } };
    const pageProps = blob.props?.pageProps;
    if (!pageProps) return { listing: null };
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

function shapeListing(r: Record<string, unknown>): DetailListing {
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

function shapeAddress(r: Record<string, unknown>): DetailListing['address'] {
  const street = pickStr(r, ['street', 'streetAddress']);
  const postalCode = pickStr(r, ['zip', 'postalCode']);
  const locality = pickStr(r, ['city', 'locality', 'addressLocality']);
  const region = pickStr(r, ['canton', 'addressRegion', 'state']);
  if (!street && !postalCode && !locality && !region) return undefined;
  const out: NonNullable<DetailListing['address']> = {};
  if (street) out.streetAddress = street;
  if (postalCode) out.postalCode = postalCode;
  if (locality) out.addressLocality = locality;
  if (region) out.addressRegion = region;
  return out;
}

function shapeImage(r: Record<string, unknown>): DetailListing['image'] {
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
