import { describe, expect, it } from 'vitest';
import { mapHomegateListing, type HomegateListing } from '../src/map.js';

const fix: HomegateListing = {
  id: 'abc-123',
  address: { locality: 'Zürich', postal_code: '8008', street: 'Forchstrasse 187' },
  characteristics: { number_of_rooms: 4.5, living_space: 112, floor: 2 },
  prices: { rent: { gross: 3200, net: 2850, extras: 350 } },
  description: 'South-facing.',
  images: ['https://cdn/i.jpg'],
  realtor: { name: 'Wincasa' },
  coordinates: { latitude: 47.36, longitude: 8.57 },
};

describe('mapHomegateListing', () => {
  it('maps a representative response', () => {
    const r = mapHomegateListing(fix);
    expect(r.id).toBe('homegate:abc-123');
    expect(r.price.total).toBe(3200);
    expect(r.rooms).toBe(4.5);
    expect(r.area_m2).toBe(112);
    expect(r.location.coords).toEqual([47.36, 8.57]);
    expect(r.location.city).toBe('Zürich');
    expect(r.agency).toBe('Wincasa');
    expect(r.url).toContain('homegate.ch');
  });
});
