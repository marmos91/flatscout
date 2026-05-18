import { describe, expect, it } from 'vitest';
import { mapDetail } from '../src/map.js';

describe('mapDetail', () => {
  it('maps a full RealEstateListing payload', () => {
    const out = mapDetail('walde', 'https://walde.ch/object-12345', {
      listing: {
        '@type': 'RealEstateListing',
        name: 'Nice flat',
        numberOfRooms: '3.5',
        floorSize: { value: '95' },
        offers: { price: '2400', priceCurrency: 'CHF' },
        address: { streetAddress: 'Bahnhofstr. 1', postalCode: '8008', addressLocality: 'Zürich' },
        image: 'https://walde.ch/i.jpg',
        description: 'A flat',
      },
    });
    expect(out?.id).toBe('agency:walde:12345');
    expect(out?.source).toBe('agency:schemaorg:walde');
    expect(out?.rooms).toBe(3.5);
    expect(out?.area_m2).toBe(95);
    expect(out?.price.total).toBe(2400);
    expect(out?.location.postal_code).toBe('8008');
    expect(out?.agency).toBe('walde');
  });
});
