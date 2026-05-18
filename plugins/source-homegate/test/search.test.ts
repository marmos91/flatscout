import { describe, expect, it } from 'vitest';
import { buildSearchBody, SearchConfig } from '../src/search.js';

describe('buildSearchBody', () => {
  it('emits only constants when config is empty', () => {
    const body = buildSearchBody(SearchConfig.parse({}), 20, 0);
    expect(body).toEqual({
      sortBy: 'dateCreated',
      sortDirection: 'desc',
      trackTotalHits: true,
      from: 0,
      size: 20,
      fieldset: 'srp-list',
      query: {
        offerType: 'RENT',
        propertyType: 'APARTMENT_OR_HOUSE',
      },
    });
  });

  it('translates zipcodes to geo-zipcode-NNNN tags', () => {
    const body = buildSearchBody(SearchConfig.parse({ zipcodes: [8008, 8032] }), 10, 0);
    expect(body.query.location?.geoTags).toEqual(['geo-zipcode-8008', 'geo-zipcode-8032']);
  });

  it('emits every set field nested correctly', () => {
    const cfg = SearchConfig.parse({
      zipcodes: [8008],
      price_min: 1000,
      price_max: 4500,
      rooms_min: 3.5,
      rooms_max: 5.5,
      surface_min: 80,
      property_type: 'APARTMENT',
      has_balcony: true,
      has_elevator: false,
      sort_by: 'price',
      sort_direction: 'asc',
    });
    const body = buildSearchBody(cfg, 25, 50);
    expect(body.sortBy).toBe('price');
    expect(body.sortDirection).toBe('asc');
    expect(body.from).toBe(50);
    expect(body.size).toBe(25);
    expect(body.query).toEqual({
      offerType: 'RENT',
      propertyType: 'APARTMENT',
      location: { geoTags: ['geo-zipcode-8008'] },
      monthlyRent: { from: 1000, to: 4500 },
      numberOfRooms: { from: 3.5, to: 5.5 },
      livingSpace: { from: 80 },
      hasBalcony: true,
      hasElevator: false,
    });
  });

  it('omits monthlyRent entirely when neither price bound is set', () => {
    const body = buildSearchBody(SearchConfig.parse({ rooms_min: 2 }), 10, 0);
    expect(body.query.monthlyRent).toBeUndefined();
    expect(body.query.numberOfRooms).toEqual({ from: 2 });
  });

  it('omits location when no zipcodes are configured', () => {
    const body = buildSearchBody(SearchConfig.parse({ price_max: 3000 }), 10, 0);
    expect(body.query.location).toBeUndefined();
  });
});
