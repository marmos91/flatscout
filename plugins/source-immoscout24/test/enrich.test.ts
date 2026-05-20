import { describe, expect, it } from 'vitest';
import type { RawListing } from '@wabe/core';
import type { DetailPayload } from '../src/detail.js';
import { mergePdpIntoListing } from '../src/enrich.js';

function baseListing(): RawListing {
  return {
    id: 'immoscout24:1',
    source: 'source-immoscout24',
    url: 'https://www.immoscout24.ch/rent/1',
    price: { rent_net: null, extras: null, total: 2400, currency: 'CHF', deposit_months: null },
    rooms: 3.5,
    area_m2: 78,
    floor: null,
    total_floors: null,
    built_year: null,
    renovated_year: null,
    location: {
      coords: null,
      address: 'Seestrasse 12',
      postal_code: '8002',
      city: 'Zürich',
      region: null,
      country: 'CH',
      neighborhood: null,
    },
    description: 'SRP description',
    photos: ['https://cdn/srp.jpg'],
    available_from: null,
    lease_until: null,
    rental_term: 'PERMANENT',
    agency: null,
    features: {},
    contact: {},
    enriched: {},
    extra: {},
  };
}

describe('mergePdpIntoListing', () => {
  it('returns the listing unchanged when PDP payload is empty', () => {
    const before = baseListing();
    const after = mergePdpIntoListing(before, { listing: null });
    expect(after).toEqual(before);
  });

  it('does not overwrite SRP-authoritative fields (rooms/price/area/description/photos/geo)', () => {
    const listing = baseListing();
    const pdp: DetailPayload = {
      listing: {
        '@type': 'RealEstateListing',
        numberOfRooms: 99,
        floorSize: { value: 999 },
        offers: { price: 99999, priceCurrency: 'CHF' },
        description: 'override',
        image: ['https://cdn/pdp1.jpg'],
        address: { streetAddress: 'override', postalCode: '0000', addressLocality: 'override' },
      },
    };
    const merged = mergePdpIntoListing(listing, pdp);
    expect(merged.rooms).toBe(3.5);
    expect(merged.area_m2).toBe(78);
    expect(merged.price.total).toBe(2400);
    expect(merged.description).toBe('SRP description');
    expect(merged.photos).toEqual(['https://cdn/srp.jpg']);
    expect(merged.location.address).toBe('Seestrasse 12');
  });

  it('fills contact/agency/lister fields when PDP carries them', () => {
    const listing = baseListing();
    const pdp = {
      listing: {
        '@type': 'RealEstateListing' as const,
        name: 'Lovely Flat',
        contact: { phone: '+41 44 555 11 22', email: 'agent@example.ch' },
        provider: { name: 'ACME Immobilien AG', url: 'https://acme.ch' },
      },
    } as DetailPayload;
    const merged = mergePdpIntoListing(listing, pdp);
    expect(merged.contact).toEqual({ phone: '+41 44 555 11 22', email: 'agent@example.ch' });
    expect(merged.agency).toBe('ACME Immobilien AG');
    expect((merged.enriched as Record<string, unknown>).lister).toMatchObject({
      legal_name: 'ACME Immobilien AG',
      website: 'https://acme.ch',
    });
  });

  it('does not overwrite SRP contact when already set', () => {
    const listing = baseListing();
    listing.contact = { phone: 'SRP-phone' };
    listing.agency = 'SRP Agency';
    const pdp = {
      listing: {
        '@type': 'RealEstateListing' as const,
        contact: { phone: 'PDP-phone', email: 'pdp@x' },
        provider: { name: 'PDP Agency' },
      },
    } as DetailPayload;
    const merged = mergePdpIntoListing(listing, pdp);
    expect(merged.contact.phone).toBe('SRP-phone');
    expect(merged.contact.email).toBe('pdp@x');
    expect(merged.agency).toBe('SRP Agency');
  });
});
