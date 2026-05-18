import { describe, expect, it } from 'vitest';
import { renderCard } from '../src/card.js';
import type { Listing } from '@wabe/core';

const baseListing: Listing = {
  id: 'f:1',
  source: 'flatfox',
  url: 'https://flatfox.ch/en/flat/1',
  first_seen_at: new Date('2026-05-17T09:50:00Z'),
  last_seen_at: new Date('2026-05-17T10:00:00Z'),
  price: { rent_net: null, extras: null, total: 3200, currency: 'CHF', deposit_months: null },
  rooms: 4.5,
  area_m2: 112,
  floor: null,
  total_floors: null,
  built_year: null,
  renovated_year: null,
  location: {
    coords: null,
    address: 'Forchstrasse 187',
    postal_code: '8008',
    city: 'Zürich',
    region: null,
    country: 'CH',
    neighborhood: 'Witikon',
  },
  features: {},
  description: null,
  photos: ['https://cdn/i.jpg'],
  available_from: null,
  lease_until: null,
  rental_term: 'unknown',
  agency: 'Wincasa',
  contact: {},
  enriched: {},
  extra: {},
};

describe('renderCard', () => {
  it('renders compact card with all key fields', () => {
    const r = renderCard(
      { listing: baseListing, score: { final: 87, breakdown: {} } },
      new Date('2026-05-17T10:14:00Z'),
    );
    expect(r.text).toContain('Witikon');
    expect(r.text).toContain('4.5Zi');
    expect(r.text).toContain('CHF 3200');
    expect(r.text).toContain('Fit 87/100');
    expect(r.text).toContain('Wincasa');
    expect(r.text).toContain('24 min ago');
    expect(r.buttons).toEqual([
      { text: '📷 Photos', url: 'https://cdn/i.jpg' },
      { text: '🔗 Open listing', url: 'https://flatfox.ch/en/flat/1' },
    ]);
  });

  it('handles missing photos and missing neighborhood gracefully', () => {
    const l: Listing = {
      ...baseListing,
      photos: [],
      location: { ...baseListing.location, neighborhood: null },
    };
    const r = renderCard({ listing: l, score: { final: 50, breakdown: {} } });
    expect(r.text).toContain('Zürich');
    expect(r.buttons).toHaveLength(1);
    expect(r.buttons[0]?.text).toBe('🔗 Open listing');
  });

  it('shows short-term row with lease end date', () => {
    const l: Listing = {
      ...baseListing,
      rental_term: 'short',
      lease_until: new Date('2026-08-31T00:00:00Z'),
    };
    const r = renderCard(
      { listing: l, score: { final: 80, breakdown: {} } },
      new Date('2026-05-17T10:14:00Z'),
    );
    expect(r.text).toContain('🗓 short-term · until 31.08.2026');
  });

  it('shows short-term row without date when lease_until missing', () => {
    const l: Listing = { ...baseListing, rental_term: 'short', lease_until: null };
    const r = renderCard(
      { listing: l, score: { final: 80, breakdown: {} } },
      new Date('2026-05-17T10:14:00Z'),
    );
    const lines = r.text.split('\n');
    expect(lines).toContain('🗓 short-term');
    expect(r.text).not.toContain('until');
  });

  it('does NOT show short-term row for long/unknown', () => {
    expect(renderCard({ listing: baseListing, score: { final: 80, breakdown: {} } }).text).not.toContain(
      'short-term',
    );
    expect(
      renderCard({
        listing: { ...baseListing, rental_term: 'long' },
        score: { final: 80, breakdown: {} },
      }).text,
    ).not.toContain('short-term');
  });

  it('renders "Also on:" footer when also_seen_on is non-empty', () => {
    const r = renderCard(
      {
        listing: baseListing,
        score: { final: 80, breakdown: {} },
        also_seen_on: ['source-homegate', 'source-realadvisor'],
      },
      new Date('2026-05-17T10:14:00Z'),
    );
    expect(r.text).toContain('Also on: homegate, realadvisor');
  });

  it('omits "Also on:" line when also_seen_on is absent or empty', () => {
    const r = renderCard(
      { listing: baseListing, score: { final: 80, breakdown: {} }, also_seen_on: [] },
      new Date('2026-05-17T10:14:00Z'),
    );
    expect(r.text).not.toContain('Also on:');
  });

  it('disablePreview=true for DataDome-walled sources (IS24 sitemap)', () => {
    const l: Listing = { ...baseListing, source: 'source-immoscout24-sitemap' };
    const r = renderCard({ listing: l, score: { final: 80, breakdown: {} } });
    expect(r.disablePreview).toBe(true);
  });

  it('disablePreview=false for normal sources (flatfox)', () => {
    const r = renderCard({ listing: baseListing, score: { final: 80, breakdown: {} } });
    expect(r.disablePreview).toBe(false);
  });
});
