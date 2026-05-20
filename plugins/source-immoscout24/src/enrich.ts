import type { RawListing } from '@wabe/core';
import type { DetailPayload } from './detail.js';

interface PdpListingExtra {
  contact?: { phone?: string; email?: string; form_url?: string };
  provider?: { name?: string; url?: string };
  telephone?: string;
  email?: string;
}

/**
 * Merges a PDP payload into a SRP-derived RawListing, filling contact-shaped
 * gaps without ever overwriting SRP-authoritative fields. SRP is the source of
 * truth for rooms / price / area / description / photos / geo — PDP only adds
 * contact channels (phone / email / form_url / agency) that SRP cards omit.
 */
export function mergePdpIntoListing(listing: RawListing, pdp: DetailPayload): RawListing {
  if (!pdp.listing) return listing;
  const pl = pdp.listing as DetailPayload['listing'] & PdpListingExtra;

  const next: RawListing = {
    ...listing,
    contact: { ...listing.contact },
    enriched: { ...listing.enriched },
  };
  const listerExtra: Record<string, unknown> = {
    ...(next.enriched.lister as Record<string, unknown> | undefined),
  };

  const phone = pl.contact?.phone ?? pl.telephone;
  if (phone && !next.contact.phone) next.contact.phone = phone;
  const email = pl.contact?.email ?? pl.email;
  if (email && !next.contact.email) next.contact.email = email;
  if (pl.contact?.form_url && !next.contact.form_url) next.contact.form_url = pl.contact.form_url;

  const providerName = pl.provider?.name;
  if (providerName) {
    if (!next.agency) next.agency = providerName;
    if (!listerExtra.legal_name) listerExtra.legal_name = providerName;
  }
  if (pl.provider?.url && !listerExtra.website) listerExtra.website = pl.provider.url;

  if (Object.keys(listerExtra).length > 0) next.enriched.lister = listerExtra;

  return next;
}
