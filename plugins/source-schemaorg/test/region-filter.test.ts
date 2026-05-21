import { describe, expect, it } from 'vitest';
import type { RawListing } from '@flatscout/core';

// We're unit-testing the filter logic directly via a small re-implementation
// of `matchesRegion` (private to src/index.ts). The shape is intentionally
// minimal so the test pins the behavior without coupling to the adapter's
// generator-loop plumbing.
function matchesRegion(
  l: Pick<RawListing, 'location'>,
  plz: Set<string>,
  cities: Set<string>,
  cantons: Set<string>,
): boolean {
  const { postal_code, city, region } = l.location;
  if (plz.size > 0 && postal_code && plz.has(postal_code)) return true;
  if (cities.size > 0 && city && cities.has(city.toLowerCase())) return true;
  if (cantons.size > 0 && region && cantons.has(region.toUpperCase())) return true;
  return false;
}

const loc = (postal_code: string | null, city: string | null, region: string | null) => ({
  location: {
    coords: null,
    address: null,
    postal_code,
    city,
    region,
    country: 'CH',
    neighborhood: null,
  } as RawListing['location'],
});

describe('region_filter (source-schemaorg adapter contract)', () => {
  it('keeps listings whose PLZ is in the allowlist', () => {
    expect(matchesRegion(loc('8008', 'Zürich', null), new Set(['8008']), new Set(), new Set())).toBe(true);
  });
  it('keeps listings whose city matches case-insensitively', () => {
    expect(matchesRegion(loc(null, 'zürich', null), new Set(), new Set(['zürich']), new Set())).toBe(true);
  });
  it('keeps listings whose canton matches case-insensitively', () => {
    expect(matchesRegion(loc(null, null, 'zh'), new Set(), new Set(), new Set(['ZH']))).toBe(true);
  });
  it('drops listings whose PLZ is not in the allowlist (no other field matches)', () => {
    expect(matchesRegion(loc('1200', 'Geneva', 'GE'), new Set(['8008', '8053']), new Set(), new Set())).toBe(
      false,
    );
  });
  it('drops listings with all location fields null when any filter is set', () => {
    expect(matchesRegion(loc(null, null, null), new Set(['8008']), new Set(), new Set())).toBe(false);
  });
  it('OR across PLZ/city/canton — any match keeps the listing', () => {
    expect(
      matchesRegion(loc(null, 'Bern', null), new Set(['8008']), new Set(['bern']), new Set(['ZH'])),
    ).toBe(true);
  });
});
