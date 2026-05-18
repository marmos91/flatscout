import { describe, expect, it } from 'vitest';
import { applyClientFilters, buildQuery, SearchConfig } from '../src/search.js';

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
      object_category: 'FLAT',
    },
    {
      pk: 2,
      city: 'Bern',
      price_display: 2000,
      number_of_rooms: '4.0',
      surface_living: 90,
      offer_type: 'RENT',
      object_category: 'FLAT',
    },
    {
      pk: 3,
      city: 'Zürich',
      price_display: 5000,
      number_of_rooms: '5.0',
      surface_living: 130,
      offer_type: 'RENT',
      object_category: 'FLAT',
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
