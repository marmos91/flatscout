import { describe, expect, it } from 'vitest';
import { mapFlatfoxListing, type FlatfoxApiResult } from '../src/map.js';

const fixture: FlatfoxApiResult = {
  pk: 51159,
  slug: 'address-slug',
  city: 'Zürich',
  zipcode: 8005,
  price_display: 2850,
  price_unit: 'monthly',
  number_of_rooms: '2.0',
  surface_living: 85,
  public_title: '8005 Zürich - CHF 2’850 incl. utilities per month',
  description: 'Bright corner flat.',
  latitude: 47.385,
  longitude: 8.527,
  offer_type: 'RENT',
  object_category: 'APARTMENT',
  status: 'act',
  published: '2026-05-17T08:30:00Z',
  agency: { name: 'ACME Immo AG' },
  images: ['https://cdn/img.jpg', { original_url: 'https://cdn/img2.jpg' }],
};

describe('mapFlatfoxListing', () => {
  it('maps a representative response', () => {
    const r = mapFlatfoxListing(fixture);
    expect(r.id).toBe('flatfox:51159');
    expect(r.url).toBe('https://flatfox.ch/en/flat/51159/address-slug');
    expect(r.price.total).toBe(2850);
    expect(r.rooms).toBe(2.0);
    expect(r.area_m2).toBe(85);
    expect(r.location.coords).toEqual([47.385, 8.527]);
    expect(r.location.city).toBe('Zürich');
    expect(r.location.postal_code).toBe('8005');
    expect(r.agency).toBe('ACME Immo AG');
    expect(r.photos).toHaveLength(2);
  });

  it('coerces string number_of_rooms', () => {
    expect(mapFlatfoxListing({ pk: 1, number_of_rooms: '3.5' }).rooms).toBe(3.5);
  });

  it('falls back to public_title when description missing', () => {
    expect(mapFlatfoxListing({ pk: 1, public_title: 'X' }).description).toBe('X');
  });

  it('omits coords when lat/lng missing', () => {
    expect(mapFlatfoxListing({ pk: 1 }).location.coords).toBeNull();
  });
});
