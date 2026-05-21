import { collectJsonLdFacts, type JsonLdListing } from './detail.js';

export interface ExtractedListing {
  /** Which extraction tier produced this listing — useful for downstream confidence weighting. */
  tier: 'jsonld' | 'opengraph-regex';
  title: string | null;
  description: string | null;
  url: string;
  photos: string[];
  price_chf: number | null;
  currency: string;
  rooms: number | null;
  area_m2: number | null;
  address: {
    street: string | null;
    postal_code: string | null;
    city: string | null;
    region: string | null;
  };
  geo: { lat: number | null; lon: number | null };
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Tier 1 — turn a parsed JSON-LD listing object into the unified shape.
 *
 * Pulls fields from the anchor first, falling back to auxiliary graph nodes
 * for facts that the anchor doesn't carry inline. CasaWP for example places
 * `numberOfRooms`/`floorSize`/`address`/`geo` on a separate `Apartment` node
 * and the price under `Offer.priceSpecification.price` (UnitPriceSpecification).
 */
function fromJsonLd(
  l: JsonLdListing,
  url: string,
  aux?: ReturnType<typeof collectJsonLdFacts>,
): ExtractedListing {
  const apartmentAux = aux?.anchorCandidates.find((c) => (c['@type'] as string) === 'Apartment' && c !== l);
  const houseAux = aux?.anchorCandidates.find(
    (c) => (c['@type'] as string) === 'House' || (c['@type'] as string) === 'SingleFamilyResidence',
  );
  const sup = apartmentAux ?? houseAux;
  const supAddress = (sup?.address ?? l.address) as JsonLdListing['address'];
  const supGeo = (sup?.geo ?? l.geo) as JsonLdListing['geo'];
  const supFloor = (sup?.floorSize ?? l.floorSize) as JsonLdListing['floorSize'];
  const supRooms = (sup as { numberOfRooms?: unknown } | undefined)?.numberOfRooms ?? l.numberOfRooms;

  // Price: anchor offer → first Offer node in graph → first PriceSpecification
  let price: number | null = toNum(l.offers?.price);
  let currency: string | undefined = l.offers?.priceCurrency;
  if (price === null && aux?.offers.length) {
    for (const o of aux.offers) {
      const direct = toNum((o as { price?: unknown }).price);
      if (direct !== null) {
        price = direct;
        currency = currency ?? (o as { priceCurrency?: string }).priceCurrency ?? undefined;
        break;
      }
      const spec = (o as { priceSpecification?: { price?: unknown; priceCurrency?: string } })
        .priceSpecification;
      if (spec) {
        const sp = toNum(spec.price);
        if (sp !== null) {
          price = sp;
          currency = currency ?? spec.priceCurrency ?? undefined;
          break;
        }
      }
    }
  }
  if (price === null && aux?.priceSpecs.length) {
    for (const ps of aux.priceSpecs) {
      const sp = toNum((ps as { price?: unknown }).price);
      if (sp !== null) {
        price = sp;
        currency = currency ?? (ps as { priceCurrency?: string }).priceCurrency ?? undefined;
        break;
      }
    }
  }

  // Photos: anchor → Apartment aux → first ImageObject seen anywhere
  let photos: string[] = Array.isArray(l.image) ? l.image : l.image ? [l.image] : [];
  if (photos.length === 0 && sup) {
    const supImg = (sup as { image?: unknown }).image;
    photos = Array.isArray(supImg)
      ? (supImg.filter((x) => typeof x === 'string') as string[])
      : typeof supImg === 'string'
        ? [supImg]
        : [];
  }

  return {
    tier: 'jsonld',
    title: l.name ?? (sup as { name?: string } | undefined)?.name ?? null,
    description: l.description ?? null,
    url,
    photos,
    price_chf: price,
    currency: currency ?? 'CHF',
    rooms: toNum(supRooms),
    area_m2: toNum(supFloor?.value),
    address: {
      street: supAddress?.streetAddress ?? null,
      postal_code: supAddress?.postalCode ?? null,
      city: supAddress?.addressLocality ?? null,
      region: supAddress?.addressRegion ?? null,
    },
    geo: { lat: toNum(supGeo?.latitude), lon: toNum(supGeo?.longitude) },
  };
}

const META_PROPERTY_RE = /<meta[^>]+(?:property|name)=["']([^"']+)["'][^>]+content=["']([^"']*)["'][^>]*>/gi;
const META_CONTENT_FIRST_RE =
  /<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']([^"']+)["'][^>]*>/gi;
// CHF or "Fr." prefix, optional space, then an amount with optional thousands
// separators (apostrophe, comma, dot, space). Reject < 200 (too cheap to be a
// listing) and > 5_000_000 (too expensive). Match per-month and total alike;
// the caller doesn't know which.
const PRICE_RE = /(?:CHF|Fr\.?)\s?([\d][\d'\.  ,\s]{1,12})(?:\s*\.\s?-)?/i;
const ROOMS_RE = /([\d][.,]?\d?)\s*(?:Zimmer|pièces|locali|rooms?|stanze|chambres?)/i;
const AREA_RE = /([\d]{2,4}(?:[.,]\d+)?)\s*m(?:²|\s*2|q)/i;
const POSTAL_CITY_RE = /(?:^|[^\d])(\d{4})\s+([A-ZÄÖÜ][A-Za-zÄÖÜäöüéèêàâîô\- ]{1,40})/;
const STREET_RE =
  /\b([A-ZÄÖÜ][\wäöüéèêàâôîç-]{2,}(?:strasse|gasse|weg|platz|allee|hof|str\.|str|chemin|rue|route|via|viale))\s+(\d+[a-z]?)/i;

function parsePriceLike(raw: string): number | null {
  // Drop spaces, apostrophes, and treat last separator (`.` or `,`) as decimal
  // only when followed by 1-2 digits — else it's a thousands grouper.
  const cleaned = raw.replace(/[\s  ']/g, '');
  // If the value uses dot as decimal (e.g. 1234.50) leave it; otherwise drop both.
  const m = cleaned.match(/^(\d+)(?:[\.,](\d{1,2}))?$/);
  if (m) {
    const whole = Number.parseInt(m[1] ?? '0', 10);
    const dec = m[2] ? Number.parseInt(m[2], 10) / 10 ** m[2].length : 0;
    return Number.isFinite(whole) ? whole + dec : null;
  }
  // Fallback: strip all non-digits, accept if length plausible.
  const digits = cleaned.replace(/[^\d]/g, '');
  const n = Number.parseInt(digits, 10);
  return Number.isFinite(n) ? n : null;
}

interface Meta {
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: string[];
  ogUrl?: string;
}

function readMeta(html: string): Meta {
  const meta: Meta = {};
  const visit = (prop: string, content: string) => {
    const p = prop.toLowerCase();
    if (p === 'og:title') meta.ogTitle = meta.ogTitle ?? content;
    else if (p === 'og:description' || p === 'description')
      meta.ogDescription = meta.ogDescription ?? content;
    else if (p === 'og:image' || p === 'og:image:url' || p === 'og:image:secure_url') {
      meta.ogImage = meta.ogImage ?? [];
      if (content) meta.ogImage.push(content);
    } else if (p === 'og:url') meta.ogUrl = meta.ogUrl ?? content;
  };
  for (const m of html.matchAll(META_PROPERTY_RE)) {
    if (m[1] && m[2] !== undefined) visit(m[1], m[2]);
  }
  for (const m of html.matchAll(META_CONTENT_FIRST_RE)) {
    if (m[2] && m[1] !== undefined) visit(m[2], m[1]);
  }
  return meta;
}

/**
 * Tier 2 — extract listing facts from Open Graph meta + regex over the page
 * body. Returns null when the page lacks the two minimum signals (price plus
 * either rooms or area). Used by the schemaorg adapter when no JSON-LD
 * listing block is present.
 */
export function extractOpenGraph(html: string, url: string): ExtractedListing | null {
  const meta = readMeta(html);
  // Strip script/style content from the candidate text so JS literals don't
  // produce phantom prices.
  const visible = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const priceMatch = visible.match(PRICE_RE);
  const price = priceMatch?.[1] ? parsePriceLike(priceMatch[1]) : null;
  const roomsMatch = visible.match(ROOMS_RE);
  const rooms = roomsMatch?.[1] ? Number.parseFloat(roomsMatch[1].replace(',', '.')) : null;
  const areaMatch = visible.match(AREA_RE);
  const area = areaMatch?.[1] ? Number.parseFloat(areaMatch[1].replace(',', '.')) : null;
  if (price === null || price < 200 || price > 5_000_000) return null;
  if (rooms === null && area === null) return null;
  // Address heuristics: best-effort. Many sites print "8008 Zürich" or
  // "<street> <number>". When both fail we leave nulls — the listing still
  // passes downstream as long as price + (rooms || area) are set.
  const postalCityMatch = visible.match(POSTAL_CITY_RE);
  const streetMatch = visible.match(STREET_RE);
  const street = streetMatch ? `${streetMatch[1]} ${streetMatch[2]}` : null;
  const postal = postalCityMatch?.[1] ?? null;
  const city = postalCityMatch?.[2]?.trim() ?? null;
  return {
    tier: 'opengraph-regex',
    title: meta.ogTitle ?? null,
    description: meta.ogDescription ?? null,
    url: meta.ogUrl ?? url,
    photos: meta.ogImage ?? [],
    price_chf: price,
    currency: 'CHF',
    rooms: Number.isFinite(rooms) ? rooms : null,
    area_m2: Number.isFinite(area) ? area : null,
    address: { street, postal_code: postal, city, region: null },
    geo: { lat: null, lon: null },
  };
}

/**
 * Combined Tier 1 (JSON-LD) → Tier 2 (OG + regex) extraction. Returns null
 * only when both tiers fail. Pages that match Tier 1 never fall through.
 */
export function extractListing(html: string, url: string): ExtractedListing | null {
  const facts = collectJsonLdFacts(html);
  if (facts.anchor) return fromJsonLd(facts.anchor, url, facts);
  return extractOpenGraph(html, url);
}
