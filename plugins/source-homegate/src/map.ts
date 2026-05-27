import { z } from 'zod';
import { classifyRentalTerm, type RawListing } from '@flatscout/core';

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

const ListerContactEntry = z
  .object({
    phone: z.string().optional(),
    email: z.string().optional(),
    givenName: z.string().optional(),
    familyName: z.string().optional(),
    gender: z.string().optional(),
  })
  .partial()
  .passthrough();

const Lister = z
  .object({
    id: z.string().optional(),
    legalName: z.string().optional(),
    phone: z.string().optional(),
    logoUrl: z.string().optional(),
    website: z.object({ value: z.string().optional() }).partial().passthrough().optional(),
    contacts: z
      .object({
        viewing: ListerContactEntry.optional(),
        inquiry: ListerContactEntry.optional(),
      })
      .partial()
      .passthrough()
      .optional(),
    address: z
      .object({
        locality: z.string().optional(),
        country: z.string().optional(),
        postalCode: z.string().optional(),
        street: z.string().optional(),
      })
      .partial()
      .passthrough()
      .optional(),
  })
  .partial()
  .passthrough();

const Listing = z
  .object({
    id: z.string(),
    availableFrom: z.string().optional(),
    lister: Lister.optional(),
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
        region: z.string().optional(),
        geoTags: z.array(z.string()).optional(),
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
    listingType: z.record(z.string(), z.unknown()).optional(),
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
 * classifier used by `@flatscout/source-flatfox` — Homegate's search fieldset
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
  // GeoJSON order: [lng, lat] (matches Listing.location.coords convention).
  const coords: [number, number] | null =
    geo?.latitude != null && geo.longitude != null ? [geo.longitude, geo.latitude] : null;

  const loc = r.localization;
  const primaryLang = (loc?.primary ?? 'de') as 'de' | 'en' | 'fr' | 'it';
  const primaryEntry =
    (loc?.[primaryLang] as z.infer<typeof Localization> | undefined) ??
    loc?.de ??
    loc?.en ??
    loc?.fr ??
    loc?.it ??
    undefined;

  const title = primaryEntry?.text?.title ?? null;
  const description = primaryEntry?.text?.description ?? null;
  const photos = (primaryEntry?.attachments ?? [])
    .filter((a) => a.type === 'IMAGE' && typeof a.url === 'string' && a.url.length > 0)
    .map((a) => a.url as string);

  const classifierText = [title, description].filter(Boolean).join(' ');
  const classified = classifyRentalTerm({
    description: classifierText || null,
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

  const lister = r.lister;
  const inquiry = lister?.contacts?.inquiry;
  const viewing = lister?.contacts?.viewing;

  // Strict canonical contact (RawListing schema only accepts phone/email/form_url).
  const contact: Record<string, unknown> = {};
  const inquiryPhone = inquiry?.phone ?? lister?.phone;
  if (inquiryPhone) contact.phone = inquiryPhone;
  if (inquiry?.email) contact.email = inquiry.email;

  // Richer lister metadata goes under `enriched.lister` so it survives schema validation
  // while remaining available for source-aware downstream tooling (UI, dedup hints).
  const inquiryName = [inquiry?.givenName, inquiry?.familyName].filter(Boolean).join(' ').trim();
  const viewingName = [viewing?.givenName, viewing?.familyName].filter(Boolean).join(' ').trim();
  const listerExtra: Record<string, unknown> = {};
  if (lister?.legalName) listerExtra.legal_name = lister.legalName;
  if (lister?.website?.value) listerExtra.website = lister.website.value;
  if (lister?.logoUrl) listerExtra.logo_url = lister.logoUrl;
  if (inquiryName) listerExtra.inquiry_contact = inquiryName;
  if (viewingName && viewingName !== inquiryName) listerExtra.viewing_contact = viewingName;
  if (lister?.address?.locality) listerExtra.address_locality = lister.address.locality;
  const enriched: Record<string, unknown> = {};
  if (Object.keys(listerExtra).length > 0) enriched.lister = listerExtra;

  const neighborhood =
    (r.address?.geoTags ?? [])
      .find((t) => t.startsWith('geo-citydistrict-'))
      ?.replace('geo-citydistrict-', '') ?? null;

  const availableFrom = (() => {
    const raw = r.availableFrom;
    if (!raw) return null;
    const d = new Date(raw);
    return Number.isFinite(d.getTime()) ? d : null;
  })();

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
      region: r.address?.region ?? null,
      country: 'CH',
      neighborhood,
    },
    description,
    photos,
    available_from: availableFrom,
    lease_until: classified.lease_until,
    rental_term: classified.rental_term,
    agency: lister?.legalName ?? null,
    features,
    contact,
    enriched,
    extra: {},
  };
}
