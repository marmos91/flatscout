import { describe, expect, it } from 'vitest';
import { mapDetail } from '../src/map.js';

describe('mapDetail', () => {
  it('maps a full Product + Residence payload', () => {
    const url = 'https://www.immobilier.ch/en/rent/zurich/zurich/great-flat-12345';
    const out = mapDetail(url, {
      product: { '@type': 'Product', description: 'A flat', offers: { price: '3200', priceCurrency: 'CHF' }, image: 'https://x/i.jpg' },
      residence: {
        '@type': 'Residence',
        address: { streetAddress: 'Forchstrasse 187', postalCode: '8008', addressLocality: 'Zürich' },
        numberOfRooms: '4.5',
        floorSize: { value: '112' },
      },
    });
    expect(out?.id).toBe('immobilier-ch:12345');
    expect(out?.rooms).toBe(4.5);
    expect(out?.area_m2).toBe(112);
    expect(out?.price.total).toBe(3200);
    expect(out?.location.postal_code).toBe('8008');
  });
  it('returns null when Product is absent', () => {
    expect(mapDetail('https://x/abc-1', { product: null, residence: null })).toBeNull();
  });
});
