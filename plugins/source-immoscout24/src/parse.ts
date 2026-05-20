import { z } from 'zod';

const Attachment = z
  .object({
    alt: z.string().nullable().optional(),
    file: z.string().optional(),
    type: z.string().optional(),
    url: z.string().optional(),
  })
  .passthrough();

const Localization = z
  .object({
    text: z
      .object({
        title: z.string().optional(),
        description: z.string().optional(),
      })
      .partial()
      .passthrough()
      .optional(),
    attachments: z.array(Attachment).optional(),
  })
  .partial()
  .passthrough();

const Address = z
  .object({
    geoCoordinates: z
      .object({
        latitude: z.number().optional(),
        longitude: z.number().optional(),
        accuracy: z.string().optional(),
      })
      .partial()
      .passthrough()
      .optional(),
    locality: z.string().optional(),
    postalCode: z.string().optional(),
    street: z.string().optional(),
  })
  .partial()
  .passthrough();

const Characteristics = z
  .object({
    numberOfRooms: z.number().optional(),
    livingSpace: z.number().optional(),
    hasBalcony: z.boolean().optional(),
    hasElevator: z.boolean().optional(),
    hasParking: z.boolean().optional(),
    hasGarage: z.boolean().optional(),
    hasDishwasher: z.boolean().optional(),
    yearBuilt: z.number().optional(),
    yearLastRenovated: z.number().optional(),
    numberOfBathrooms: z.number().optional(),
  })
  .partial()
  .passthrough();

const Prices = z
  .object({
    rent: z
      .object({
        gross: z.number().optional(),
        net: z.number().optional(),
        interval: z.string().optional(),
      })
      .partial()
      .passthrough()
      .optional(),
    currency: z.string().optional(),
  })
  .partial()
  .passthrough();

export const IS24SrpListingSchema = z
  .object({
    id: z.string(),
    listingType: z.object({ type: z.string().optional() }).partial().passthrough().optional(),
    listing: z
      .object({
        id: z.string().optional(),
        address: Address.optional(),
        categories: z.array(z.string()).optional(),
        characteristics: Characteristics.optional(),
        localization: z
          .object({
            de: Localization.optional(),
            en: Localization.optional(),
            fr: Localization.optional(),
            it: Localization.optional(),
          })
          .partial()
          .passthrough()
          .optional(),
        meta: z.object({ createdAt: z.string().optional() }).partial().passthrough().optional(),
        offerType: z.string().optional(),
        platforms: z.array(z.string()).optional(),
        prices: Prices.optional(),
      })
      .passthrough(),
    listerBranding: z
      .object({
        logoUrl: z.string().optional(),
        subscriptionType: z.string().optional(),
        basePackage: z.string().nullable().optional(),
        isQualityPartner: z.boolean().optional(),
        isPremiumBranding: z.boolean().optional(),
      })
      .partial()
      .passthrough()
      .optional(),
  })
  .passthrough();
export type IS24SrpListing = z.infer<typeof IS24SrpListingSchema>;

export interface IS24SearchResult {
  resultList: {
    search: {
      fullSearch: {
        result: {
          listings: IS24SrpListing[];
          page: number;
          pageCount: number;
          resultCount: number;
          itemsPerPage: number;
          hasNextPage: boolean;
          hasPreviousPage: boolean;
          start: number;
        };
      };
    };
  };
}

export const IS24SearchResultSchema: z.ZodType<IS24SearchResult> = z
  .object({
    resultList: z
      .object({
        search: z
          .object({
            fullSearch: z
              .object({
                result: z
                  .object({
                    listings: z.array(IS24SrpListingSchema),
                    page: z.number(),
                    pageCount: z.number(),
                    resultCount: z.number(),
                    itemsPerPage: z.number(),
                    hasNextPage: z.boolean(),
                    hasPreviousPage: z.boolean(),
                    start: z.number(),
                  })
                  .passthrough(),
              })
              .passthrough(),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough() as unknown as z.ZodType<IS24SearchResult>;

const INITIAL_STATE_RE = /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/;

export function extractInitialState(html: string): IS24SearchResult | null {
  const m = html.match(INITIAL_STATE_RE);
  if (!m?.[1]) return null;
  let blob: unknown;
  try {
    blob = JSON.parse(m[1]);
  } catch {
    return null;
  }
  const parsed = IS24SearchResultSchema.safeParse(blob);
  if (!parsed.success) return null;
  return parsed.data;
}

/**
 * Pagination + listings as returned by `api.immoscout24.ch/search/listings`.
 * IS24's web client migrated this off SSR — the Pinia store now hydrates from
 * this XHR endpoint, so we call it directly through the bridge.
 *
 * Wire shape was unverified at the time of writing; the parser accepts both
 * a flat `{ listings, page, ... }` object and a `{ result: {...} }` wrapper
 * because we don't yet know which one IS24 emits. If a future probe confirms
 * a single shape, narrow this.
 */
export interface IS24SearchPage {
  listings: IS24SrpListing[];
  page: number;
  pageCount: number;
  resultCount: number;
  itemsPerPage: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

const IS24SearchPageSchema = z
  .object({
    listings: z.array(IS24SrpListingSchema),
    page: z.number(),
    pageCount: z.number(),
    resultCount: z.number(),
    itemsPerPage: z.number(),
    hasNextPage: z.boolean(),
    hasPreviousPage: z.boolean(),
  })
  .passthrough();

export function parseApiResult(body: string): IS24SearchPage | null {
  let blob: unknown;
  try {
    blob = JSON.parse(body);
  } catch {
    return null;
  }
  const candidates: unknown[] = [blob];
  if (blob && typeof blob === 'object') {
    const obj = blob as Record<string, unknown>;
    if (obj.result) candidates.push(obj.result);
    if (obj.data) candidates.push(obj.data);
    if (obj.resultList) candidates.push(obj.resultList);
  }
  for (const c of candidates) {
    const parsed = IS24SearchPageSchema.safeParse(c);
    if (parsed.success) return parsed.data;
  }
  return null;
}
