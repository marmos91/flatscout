import { describe, expect, it } from 'vitest';
import { classifyRentalTerm, parseDateStrict } from '../src/engine/rental-term.js';

describe('parseDateStrict', () => {
  it('parses DD.MM.YYYY', () => {
    expect(parseDateStrict('31.05.2025')?.toISOString()).toBe('2025-05-31T00:00:00.000Z');
  });
  it('parses DD/MM/YYYY', () => {
    expect(parseDateStrict('30/06/2025')?.toISOString()).toBe('2025-06-30T00:00:00.000Z');
  });
  it('parses two-digit year >= 70 as 19xx', () => {
    expect(parseDateStrict('01.01.99')?.toISOString()).toBe('1999-01-01T00:00:00.000Z');
  });
  it('parses two-digit year < 70 as 20xx', () => {
    expect(parseDateStrict('01.01.25')?.toISOString()).toBe('2025-01-01T00:00:00.000Z');
  });
  it('rejects garbage', () => {
    expect(parseDateStrict('foo')).toBeNull();
  });
  it('rejects invalid day-month combos (round-trip guard)', () => {
    expect(parseDateStrict('31.02.2025')).toBeNull();
    expect(parseDateStrict('00.05.2025')).toBeNull();
    expect(parseDateStrict('05.13.2025')).toBeNull();
  });
});

describe('classifyRentalTerm', () => {
  it('structured lease_until wins over description', () => {
    const lease = new Date('2026-12-31T00:00:00Z');
    const r = classifyRentalTerm({
      description: 'unbefristet vermietet',
      lease_until: lease,
    });
    expect(r.rental_term).toBe('short');
    expect(r.lease_until).toEqual(lease);
    expect(r.signal).toBe('structured');
  });

  it('is_furnished=true without description → short, no date', () => {
    const r = classifyRentalTerm({ is_furnished: true });
    expect(r.rental_term).toBe('short');
    expect(r.lease_until).toBeNull();
    expect(r.signal).toBe('structured');
  });

  it('befristet bis 31.05.2025 → short with parsed date', () => {
    const r = classifyRentalTerm({
      description: 'BEFRISTET BIS 31.05.2025 zu vermieten im Kreis 7',
    });
    expect(r.rental_term).toBe('short');
    expect(r.lease_until?.toISOString()).toBe('2025-05-31T00:00:00.000Z');
    expect(r.signal).toBe('description');
  });

  it('möbliert without date → short, lease_until null', () => {
    const r = classifyRentalTerm({ description: 'Schöne möblierte 2-Zimmer Wohnung' });
    expect(r.rental_term).toBe('short');
    expect(r.lease_until).toBeNull();
  });

  it('unbefristet → long', () => {
    const r = classifyRentalTerm({ description: 'Unbefristete Vermietung in Zürich' });
    expect(r.rental_term).toBe('long');
    expect(r.lease_until).toBeNull();
  });

  it('empty/null input → unknown', () => {
    expect(classifyRentalTerm({}).rental_term).toBe('unknown');
    expect(classifyRentalTerm({ description: null }).rental_term).toBe('unknown');
    expect(classifyRentalTerm({ description: '' }).rental_term).toBe('unknown');
  });

  it('short marker outranks long marker when both present', () => {
    const r = classifyRentalTerm({
      description: 'möbliert auf Zeit, langfristig auch möglich',
    });
    expect(r.rental_term).toBe('short');
  });

  it('description with no markers → unknown', () => {
    const r = classifyRentalTerm({
      description: 'Schöne 4-Zimmer Wohnung mit Balkon und Garage',
    });
    expect(r.rental_term).toBe('unknown');
    expect(r.signal).toBe('none');
  });

  it('unparseable date in pattern → short, lease_until null', () => {
    const r = classifyRentalTerm({ description: 'befristet bis 99.99.9999 vermietet' });
    expect(r.rental_term).toBe('short');
    expect(r.lease_until).toBeNull();
  });

  it('markdown-emphasis around marker and date is tolerated', () => {
    const r = classifyRentalTerm({
      description: 'wir vermieten die Wohnung **befristet** per sofort bis zum **31.05.2025.**',
    });
    expect(r.rental_term).toBe('short');
    expect(r.lease_until?.toISOString()).toBe('2025-05-31T00:00:00.000Z');
  });
});
