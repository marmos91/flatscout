import { describe, expect, it } from 'vitest';
import { AgencyEntry, AgencyRegistry } from '../src/schemas/agency-registry.js';

describe('AgencyEntry', () => {
  it('accepts a minimum-viable entry with defaults', () => {
    const parsed = AgencyEntry.parse({
      id: 'walde',
      name: 'Walde Immobilien',
      website: 'https://walde.ch',
      canton: 'ZH',
      platform: 'schemaorg',
    });
    expect(parsed.enabled).toBe(true);
    expect(parsed.priority).toBe(100);
    expect(parsed.rate_limit_per_min).toBe(6);
  });
  it('rejects non-kebab id', () => {
    expect(() =>
      AgencyEntry.parse({
        id: 'Walde Immo',
        name: 'x',
        website: 'https://x.ch',
        canton: 'ZH',
        platform: 'schemaorg',
      }),
    ).toThrow();
  });
  it('rejects unknown canton', () => {
    expect(() =>
      AgencyEntry.parse({ id: 'x', name: 'x', website: 'https://x.ch', canton: 'XX', platform: 'schemaorg' }),
    ).toThrow();
  });
  it('rejects unknown platform', () => {
    expect(() =>
      AgencyEntry.parse({ id: 'x', name: 'x', website: 'https://x.ch', canton: 'ZH', platform: 'bogus' }),
    ).toThrow();
  });
});

describe('AgencyRegistry', () => {
  it('parses a minimal registry', () => {
    const r = AgencyRegistry.parse({
      version: 1,
      source: 'marco-private-2026q2',
      agencies: [
        {
          id: 'walde',
          name: 'Walde Immobilien',
          website: 'https://walde.ch',
          canton: 'ZH',
          platform: 'schemaorg',
        },
      ],
    });
    expect(r.agencies).toHaveLength(1);
    expect(r.agencies[0]?.id).toBe('walde');
  });
  it('rejects wrong version', () => {
    expect(() => AgencyRegistry.parse({ version: 2, source: 'x', agencies: [] })).toThrow();
  });
});
