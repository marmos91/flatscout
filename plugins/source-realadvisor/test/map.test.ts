import { describe, expect, it } from 'vitest';
import { mapHit } from '../src/map.js';

describe('mapHit', () => {
  it('maps a minimum-viable hit', () => {
    const out = mapHit({
      id: 123,
      number_of_rooms: 4.5,
      living_surface: 112,
      gross_rent_monthly: 3200,
      currency: 'CHF',
      postcode: '8008',
      locality: 'Zürich',
      state: 'ZH',
    });
    expect(out?.id).toBe('realadvisor:123');
    expect(out?.source).toBe('source-realadvisor');
    expect(out?.rooms).toBe(4.5);
    expect(out?.area_m2).toBe(112);
    expect(out?.price.total).toBe(3200);
    expect(out?.location.postal_code).toBe('8008');
  });

  it('builds the canonical listing URL from the hit id', () => {
    const out = mapHit({ id: 987 });
    expect(out?.url).toBe('https://realadvisor.ch/en/listing/987');
  });

  it('returns null when id is missing', () => {
    expect(mapHit({ id: '' } as unknown as Parameters<typeof mapHit>[0])).toBeNull();
  });
});
