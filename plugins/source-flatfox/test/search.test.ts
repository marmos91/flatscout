import { describe, expect, it } from 'vitest';
import { applyClientFilters, buildQuery, haversineMeters, SearchConfig } from '../src/search.js';

describe('buildQuery', () => {
  it('includes status + pagination', () => {
    const q = buildQuery(SearchConfig.parse({}), 50, 100);
    expect(q).toContain('status=act');
    expect(q).toContain('limit=50');
    expect(q).toContain('offset=100');
  });
});

describe('applyClientFilters', () => {
  const items = [
    {
      pk: 1,
      city: 'Zürich',
      price_display: 2400,
      number_of_rooms: '3.5',
      surface_living: 80,
      offer_type: 'RENT',
      object_category: 'APARTMENT',
    },
    {
      pk: 2,
      city: 'Bern',
      price_display: 2000,
      number_of_rooms: '4.0',
      surface_living: 90,
      offer_type: 'RENT',
      object_category: 'APARTMENT',
    },
    {
      pk: 3,
      city: 'Zürich',
      price_display: 5000,
      number_of_rooms: '5.0',
      surface_living: 130,
      offer_type: 'RENT',
      object_category: 'APARTMENT',
    },
  ];
  it('filters by city', () => {
    expect(applyClientFilters(items, SearchConfig.parse({ cities: ['Zürich'] })).map((i) => i.pk)).toEqual([
      1, 3,
    ]);
  });
  it('filters by price_max', () => {
    expect(applyClientFilters(items, SearchConfig.parse({ price_max: 3000 })).map((i) => i.pk)).toEqual([
      1, 2,
    ]);
  });
  it('filters by rooms_min', () => {
    expect(applyClientFilters(items, SearchConfig.parse({ rooms_min: 4 })).map((i) => i.pk)).toEqual([2, 3]);
  });
  it('combines filters', () => {
    expect(
      applyClientFilters(items, SearchConfig.parse({ cities: ['Zürich'], price_max: 3000 })).map((i) => i.pk),
    ).toEqual([1]);
  });
});

describe('haversineMeters', () => {
  it('identity is 0', () => {
    expect(haversineMeters({ lat: 47.36, lon: 8.55 }, { lat: 47.36, lon: 8.55 })).toBe(0);
  });
  it('returns +Infinity if either point missing', () => {
    expect(haversineMeters(null, { lat: 1, lon: 1 })).toBe(Number.POSITIVE_INFINITY);
    expect(haversineMeters({ lat: 1, lon: 1 }, undefined)).toBe(Number.POSITIVE_INFINITY);
  });
  it('approximates known Zurich-Bern distance (~96km)', () => {
    // Zurich HB 47.3782,8.5404  vs Bern HB 46.9489,7.4396
    const d = haversineMeters({ lat: 47.3782, lon: 8.5404 }, { lat: 46.9489, lon: 7.4396 });
    expect(d).toBeGreaterThan(94_000);
    expect(d).toBeLessThan(98_000);
  });
});

describe('applyClientFilters with near', () => {
  const anchor = { lat: 47.3599375, lon: 8.5667819, radius_m: 1000 };
  const inside = {
    pk: 100,
    city: 'Zürich',
    latitude: 47.362,
    longitude: 8.565,
    number_of_rooms: '3.5',
    price_display: 3000,
    surface_living: 80,
    offer_type: 'RENT',
    object_category: 'APARTMENT',
  };
  const outside = {
    pk: 101,
    city: 'Zürich',
    latitude: 47.38,
    longitude: 8.54,
    number_of_rooms: '3.5',
    price_display: 3000,
    surface_living: 80,
    offer_type: 'RENT',
    object_category: 'APARTMENT',
  };
  const noCoords = {
    pk: 102,
    city: 'Zürich',
    number_of_rooms: '3.5',
    price_display: 3000,
    surface_living: 80,
    offer_type: 'RENT',
    object_category: 'APARTMENT',
  };
  it('keeps points inside radius', () => {
    const out = applyClientFilters([inside, outside, noCoords], SearchConfig.parse({ near: anchor }));
    expect(out.map((r) => r.pk)).toEqual([100]);
  });
});
