import { classifyRentalTerm, type RawListing } from '@wabe/core';
import type { IS24SrpListing } from './parse.js';

type Lang = 'de' | 'en' | 'fr' | 'it';

const LANG_FALLBACK: Lang[] = ['de', 'en', 'fr', 'it'];

function pickLocalization(card: IS24SrpListing, primary: Lang) {
  const loc = card.listing.localization;
  if (!loc) return undefined;
  const order: Lang[] = [primary, ...LANG_FALLBACK.filter((l) => l !== primary)];
  for (const lang of order) {
    const entry = loc[lang];
    if (entry?.text || entry?.attachments?.length) return entry;
  }
  return undefined;
}

/**
 * Maps one IS24 SRP card to the canonical RawListing shape. Returns null when
 * the card lacks a usable id — the caller logs and skips. SRP cards never
 * carry contact channels (phone/email/form_url); those are filled later by
 * `enrich.ts` if PDP enrichment is enabled.
 */
export function mapSrpListing(card: IS24SrpListing, primaryLang: Lang): RawListing | null {
  // The top-level `id` is the canonical identifier; an empty string is treated as
  // absent so callers can safely pass `{ ...card, id: '' }` to exercise the null path.
  const id = card.id;
  if (!id) return null;
  const url = `https://www.immoscout24.ch/rent/${id}`;

  const chars = card.listing.characteristics ?? {};
  const prices = card.listing.prices ?? {};
  const rent = prices.rent ?? {};
  const address = card.listing.address ?? {};
  const geo = address.geoCoordinates;
  const coords: [number, number] | null =
    geo?.latitude != null && geo.longitude != null ? [geo.longitude, geo.latitude] : null;

  const entry = pickLocalization(card, primaryLang);
  const description = entry?.text?.description ?? null;
  const title = entry?.text?.title ?? null;
  const photos = (entry?.attachments ?? [])
    .filter((a) => a.type === 'IMAGE' && typeof a.url === 'string' && a.url.length > 0)
    .map((a) => a.url as string);

  const classified = classifyRentalTerm({
    description,
    is_furnished: null,
    lease_until: null,
    min_stay_days: null,
  });

  const features: Record<string, unknown> = {};
  if (chars.hasBalcony != null) features.has_balcony = chars.hasBalcony;
  if (chars.hasElevator != null) features.has_elevator = chars.hasElevator;
  if (chars.hasParking != null) features.has_parking = chars.hasParking;
  if (chars.hasGarage != null) features.has_garage = chars.hasGarage;
  if (chars.hasDishwasher != null) features.has_dishwasher = chars.hasDishwasher;
  if (chars.numberOfBathrooms != null) features.bathrooms = chars.numberOfBathrooms;

  const enriched: Record<string, unknown> = {};
  const lister: Record<string, unknown> = {};
  if (card.listerBranding?.logoUrl) lister.logo_url = card.listerBranding.logoUrl;
  if (Object.keys(lister).length > 0) enriched.lister = lister;
  if (Array.isArray(card.listing.platforms)) {
    enriched.cross_listed_on = Array.from(
      new Set(card.listing.platforms.map((p) => p.toLowerCase())),
    ).sort();
  }
  if (card.listingType?.type) {
    enriched.is24 = {
      listing_type: card.listingType.type,
      subscription_type: card.listerBranding?.subscriptionType ?? null,
    };
  }

  const postedAt = (() => {
    const raw = card.listing.meta?.createdAt;
    if (!raw) return null;
    const d = new Date(raw);
    return Number.isFinite(d.getTime()) ? d : null;
  })();

  return {
    id: `immoscout24:${id}`,
    source: 'source-immoscout24',
    url,
    price: {
      rent_net: rent.net ?? null,
      extras: null,
      total: rent.gross ?? null,
      currency: prices.currency ?? 'CHF',
      deposit_months: null,
    },
    rooms: chars.numberOfRooms ?? null,
    area_m2: chars.livingSpace ?? null,
    floor: null,
    total_floors: null,
    built_year: chars.yearBuilt ?? null,
    renovated_year: chars.yearLastRenovated ?? null,
    location: {
      coords,
      address: address.street ?? null,
      postal_code: address.postalCode ?? null,
      city: address.locality ?? null,
      region: null,
      country: 'CH',
      neighborhood: null,
    },
    description,
    photos,
    available_from: postedAt,
    lease_until: classified.lease_until,
    rental_term: classified.rental_term,
    agency: null,
    features,
    contact: {},
    enriched,
    extra: { title },
  };
}
