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

  it('builds locality search URL from postcode + locality slug', () => {
    const out = mapHit({ id: 987, postcode: '8195', locality: 'Wäldi-Berg' });
    expect(out?.url).toBe('https://realadvisor.ch/en/rent/8195-waldi-berg/apartment');
  });

  it('falls back to canton-wide search URL when postcode or locality missing', () => {
    expect(mapHit({ id: 987 })?.url).toBe('https://realadvisor.ch/en/rent/canton-zurich/apartment');
    expect(mapHit({ id: 987, postcode: '8008' })?.url).toBe(
      'https://realadvisor.ch/en/rent/canton-zurich/apartment',
    );
  });

  it('returns null when id is missing', () => {
    expect(mapHit({ id: '' } as unknown as Parameters<typeof mapHit>[0])).toBeNull();
  });
});
