import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HomegateApiSchema, mapHomegateResult } from '../src/map.js';

const here = fileURLToPath(new URL('.', import.meta.url));

function loadFixture(name: string): ReturnType<typeof HomegateApiSchema.parse> {
  const raw = readFileSync(join(here, 'fixtures/responses', name), 'utf8');
  return HomegateApiSchema.parse(JSON.parse(raw));
}

describe('mapHomegateResult', () => {
  it('maps a vanilla long-term listing', () => {
    const r = mapHomegateResult(loadFixture('vanilla.json'));
    expect(r.id).toBe('homegate:4003127729');
    expect(r.source).toBe('homegate');
    expect(r.url).toBe('https://www.homegate.ch/rent/4003127729');
    expect(r.price.rent_net).toBe(3714);
    expect(r.price.extras).toBe(276);
    expect(r.price.total).toBe(3990);
    expect(r.price.currency).toBe('CHF');
    expect(r.rooms).toBe(4.5);
    expect(r.area_m2).toBe(110);
    expect(r.floor).toBe(3);
    expect(r.built_year).toBe(1998);
    expect(r.renovated_year).toBe(2019);
    expect(r.location.coords).toEqual([47.36023, 8.58447]);
    expect(r.location.address).toBe('Beispielstrasse 1');
    expect(r.location.postal_code).toBe('8053');
    expect(r.location.city).toBe('Zürich');
    expect(r.location.country).toBe('CH');
    expect(r.description).toContain('Balkon');
    expect(r.photos).toHaveLength(2);
    expect(r.photos[0]).toContain('media2.homegate.ch');
    expect(r.available_from).toBeNull();
    expect(r.features).toEqual({
      has_parking: true,
      has_garage: false,
      pets_allowed: true,
    });
  });

  it('classifies a furnished sublet as short-term', () => {
    const r = mapHomegateResult(loadFixture('furnished.json'));
    expect(r.id).toBe('homegate:4003200001');
    expect(r.rental_term).toBe('short');
    // Furnished sublet listing has no explicit lease_until date.
    expect(r.lease_until).toBeNull();
  });

  it('classifies "befristet bis DD.MM.YYYY" as short-term + parses lease_until', () => {
    const r = mapHomegateResult(loadFixture('befristet.json'));
    expect(r.rental_term).toBe('short');
    expect(r.lease_until?.toISOString()).toBe('2027-12-31T00:00:00.000Z');
  });

  it('passthrough preserves unknown keys without throwing', () => {
    const exotic = {
      id: 'XYZ',
      listing: {
        id: 'XYZ',
        // Future field the schema doesn't know about:
        someNewKey: { weird: 'value' },
        characteristics: { numberOfRooms: 2 },
        address: { locality: 'Bern', postalCode: '3000' },
      },
    };
    const parsed = HomegateApiSchema.parse(exotic);
    const r = mapHomegateResult(parsed);
    expect(r.id).toBe('homegate:XYZ');
    expect(r.location.city).toBe('Bern');
    expect(r.rooms).toBe(2);
  });
});
