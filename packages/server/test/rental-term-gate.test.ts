import { describe, expect, it } from 'vitest';
import type { Listing, RentalTermPolicy } from '@wabe/core';
import { passes } from '../src/rental-term-gate.js';

const NOW = new Date('2026-05-18T00:00:00Z');

function listing(over: Partial<Listing>): Listing {
  return {
    id: 'src:1',
    source: 'src',
    url: 'https://x.test/1',
    first_seen_at: NOW,
    last_seen_at: NOW,
    price: { rent_net: null, extras: null, total: null, currency: 'CHF', deposit_months: null },
    rooms: null,
    area_m2: null,
    floor: null,
    total_floors: null,
    built_year: null,
    renovated_year: null,
    location: {
      coords: null,
      address: null,
      postal_code: null,
      city: null,
      region: null,
      country: 'CH',
      neighborhood: null,
    },
    features: {},
    description: null,
    photos: [],
    available_from: null,
    lease_until: null,
    rental_term: 'unknown',
    agency: null,
    contact: {},
    enriched: {},
    extra: {},
    ...over,
  };
}

describe('passes — expired-lease auto-reject', () => {
  it('rejects regardless of mode when lease_until is in the past', () => {
    const lst = listing({ rental_term: 'short', lease_until: new Date('2025-05-31') });
    expect(passes(lst, { mode: 'long', exclude_unknown: false }, NOW)).toEqual({
      ok: false,
      reason: 'lease expired',
    });
    expect(passes(lst, { mode: 'short', exclude_unknown: false }, NOW)).toEqual({
      ok: false,
      reason: 'lease expired',
    });
  });

  it('allows a lease_until exactly equal to now', () => {
    const lst = listing({ rental_term: 'long', lease_until: NOW });
    expect(passes(lst, { mode: 'long', exclude_unknown: false }, NOW).ok).toBe(true);
  });
});

describe('passes — mode=long', () => {
  const cfg: RentalTermPolicy = { mode: 'long', exclude_unknown: false };

  it('accepts long', () => {
    expect(passes(listing({ rental_term: 'long' }), cfg, NOW).ok).toBe(true);
  });
  it('accepts unknown by default', () => {
    expect(passes(listing({ rental_term: 'unknown' }), cfg, NOW).ok).toBe(true);
  });
  it('rejects short', () => {
    expect(passes(listing({ rental_term: 'short' }), cfg, NOW)).toEqual({
      ok: false,
      reason: 'rental_term=short',
    });
  });
  it('rejects unknown when exclude_unknown=true', () => {
    const strict: RentalTermPolicy = { mode: 'long', exclude_unknown: true };
    expect(passes(listing({ rental_term: 'unknown' }), strict, NOW).ok).toBe(false);
  });
});

describe('passes — mode=short happy/sad', () => {
  const cfg: RentalTermPolicy = { mode: 'short', exclude_unknown: false };

  it('accepts short without stay', () => {
    expect(passes(listing({ rental_term: 'short' }), cfg, NOW).ok).toBe(true);
  });
  it('rejects long', () => {
    expect(passes(listing({ rental_term: 'long' }), cfg, NOW).ok).toBe(false);
  });
  it('rejects unknown', () => {
    expect(passes(listing({ rental_term: 'unknown' }), cfg, NOW).ok).toBe(false);
  });
});

describe('passes — stay window (date range)', () => {
  const cfg: RentalTermPolicy = {
    mode: 'short',
    exclude_unknown: false,
    stay: { from: new Date('2026-06-01'), to: new Date('2026-08-31') },
  };

  it('accepts when window is fully covered', () => {
    const lst = listing({
      rental_term: 'short',
      available_from: new Date('2026-05-15'),
      lease_until: new Date('2026-09-30'),
    });
    expect(passes(lst, cfg, NOW).ok).toBe(true);
  });

  it('rejects when available_from is after stay.from', () => {
    const lst = listing({
      rental_term: 'short',
      available_from: new Date('2026-06-15'),
      lease_until: new Date('2026-09-30'),
    });
    expect(passes(lst, cfg, NOW).reason).toBe('available_from after stay.from');
  });

  it('rejects when lease_until is before stay.to', () => {
    const lst = listing({
      rental_term: 'short',
      available_from: new Date('2026-05-15'),
      lease_until: new Date('2026-08-01'),
    });
    expect(passes(lst, cfg, NOW).reason).toBe('lease_until before stay.to');
  });

  it('accepts when lease_until missing (insufficient data → pass)', () => {
    const lst = listing({
      rental_term: 'short',
      available_from: new Date('2026-05-15'),
      lease_until: null,
    });
    expect(passes(lst, cfg, NOW).ok).toBe(true);
  });
});

describe('passes — stay duration band', () => {
  const cfg: RentalTermPolicy = {
    mode: 'short',
    exclude_unknown: false,
    stay: { min_months: 2, max_months: 6 },
  };

  it('accepts within band', () => {
    const lst = listing({
      rental_term: 'short',
      available_from: new Date('2026-06-01'),
      lease_until: new Date('2026-09-01'), // ~3mo
    });
    expect(passes(lst, cfg, NOW).ok).toBe(true);
  });

  it('rejects below min_months', () => {
    const lst = listing({
      rental_term: 'short',
      available_from: new Date('2026-06-01'),
      lease_until: new Date('2026-06-20'), // ~0.6mo
    });
    expect(passes(lst, cfg, NOW).reason).toMatch(/min_months/);
  });

  it('rejects above max_months', () => {
    const lst = listing({
      rental_term: 'short',
      available_from: new Date('2026-06-01'),
      lease_until: new Date('2027-06-01'), // ~12mo
    });
    expect(passes(lst, cfg, NOW).reason).toMatch(/max_months/);
  });

  it('accepts when endpoints missing (insufficient data → pass)', () => {
    const lst = listing({ rental_term: 'short', available_from: null, lease_until: null });
    expect(passes(lst, cfg, NOW).ok).toBe(true);
  });
});
