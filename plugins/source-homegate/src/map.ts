import { z } from 'zod';
import { classifyRentalTerm, type RawListing } from '@wabe/core';

/**
 * Strict-but-tolerant Zod schema for one search result envelope. The inner
 * `listing` object passes through unknown keys so unexpected fields (new
 * characteristics, new categories) don't crash a scan.
 */
const Attachment = z
  .object({
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
  .passthrough();

const Listing = z
  .object({
    id: z.string(),
    address: z
      .object({
        geoCoordinates: z
          .object({
            latitude: z.number().optional(),
            longitude: z.number().optional(),
          })
          .partial()
          .passthrough()
          .optional(),
        locality: z.string().optional(),
        postalCode: z.string().optional(),
        street: z.string().optional(),
      })
      .partial()
      .passthrough()
      .optional(),
    prices: z
      .object({
        rent: z
          .object({
            net: z.number().nullable().optional(),
            extra: z.number().nullable().optional(),
            gross: z.number().nullable().optional(),
          })
          .partial()
          .passthrough()
          .optional(),
        currency: z.string().optional(),
      })
      .partial()
      .passthrough()
      .optional(),
    characteristics: z
      .object({
        numberOfRooms: z.number().optional(),
        livingSpace: z.number().optional(),
        floor: z.number().optional(),
        yearBuilt: z.number().optional(),
        yearLastRenovated: z.number().optional(),
        hasParking: z.boolean().optional(),
        hasGarage: z.boolean().optional(),
        arePetsAllowed: z.boolean().optional(),
        hasCableTv: z.boolean().optional(),
      })
      .partial()
      .passthrough()
      .optional(),
    localization: z
      .object({
        primary: z.string().optional(),
        de: Localization.optional(),
        en: Localization.optional(),
        fr: Localization.optional(),
        it: Localization.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const HomegateApiSchema = z
  .object({
    id: z.string(),
    listingType: z.string().optional(),
    listing: Listing,
  })
  .passthrough();

export type HomegateResultEnvelope = z.infer<typeof HomegateApiSchema>;

/**
 * Maps a Homegate search-result envelope into the canonical `RawListing`
 * shape. Uses the listing's `primary` localization for description + images;
 * falls back to `de`/`en` when `primary` is missing.
 *
 * `rental_term` / `lease_until` are derived from the same multilingual
 * classifier used by `@wabe/source-flatfox` — Homegate's search fieldset
 * does not expose a structured "furnished" / "temporary" flag.
 */
export function mapHomegateResult(envelope: HomegateResultEnvelope): RawListing {
  const r = envelope.listing;
  const id = r.id;
  const url = `https://www.homegate.ch/rent/${id}`;

  const rent = r.prices?.rent ?? {};
  const currency = r.prices?.currency ?? 'CHF';

  const chars = r.characteristics ?? {};

  const geo = r.address?.geoCoordinates;
  const coords: [number, number] | null =
    geo?.latitude != null && geo.longitude != null ? [geo.latitude, geo.longitude] : null;

  const loc = r.localization;
  const primaryLang = (loc?.primary ?? 'de') as 'de' | 'en' | 'fr' | 'it';
  const primaryEntry =
    (loc?.[primaryLang] as z.infer<typeof Localization> | undefined) ??
    loc?.de ??
    loc?.en ??
    loc?.fr ??
    loc?.it ??
    undefined;

  const description = primaryEntry?.text?.description ?? null;
  const photos = (primaryEntry?.attachments ?? [])
    .filter((a) => a.type === 'IMAGE' && typeof a.url === 'string' && a.url.length > 0)
    .map((a) => a.url as string);

  const classified = classifyRentalTerm({
    description,
    is_furnished: null,
    lease_until: null,
    min_stay_days: null,
  });

  // Sparse-bag features matching the existing flatfox convention
  // (RawListing.features is `Record<string, unknown>`).
  const features: Record<string, unknown> = {};
  if (chars.hasParking != null) features.has_parking = chars.hasParking;
  if (chars.hasGarage != null) features.has_garage = chars.hasGarage;
  if (chars.arePetsAllowed != null) features.pets_allowed = chars.arePetsAllowed;

  return {
    id: `homegate:${id}`,
    source: 'homegate',
    url,
    price: {
      rent_net: rent.net ?? null,
      extras: rent.extra ?? null,
      total: rent.gross ?? null,
      currency,
      deposit_months: null,
    },
    rooms: chars.numberOfRooms ?? null,
    area_m2: chars.livingSpace ?? null,
    floor: chars.floor ?? null,
    total_floors: null,
    built_year: chars.yearBuilt ?? null,
    renovated_year: chars.yearLastRenovated ?? null,
    location: {
      coords,
      address: r.address?.street ?? null,
      postal_code: r.address?.postalCode ?? null,
      city: r.address?.locality ?? null,
      region: null,
      country: 'CH',
      neighborhood: null,
    },
    description,
    photos,
    // TODO: not in srp-list fieldset — a future pdp-full capture will close this gap.
    available_from: null,
    lease_until: classified.lease_until,
    rental_term: classified.rental_term,
    // TODO: lister name not exposed in current capture; future pdp-full will carry it.
    agency: null,
    features,
    contact: {},
    enriched: {},
    extra: {},
  };
}
