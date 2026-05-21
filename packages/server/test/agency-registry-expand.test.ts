import { describe, expect, it } from 'vitest';
import { AgencyRegistry } from '@flatscout/core';
import { expandRegistry } from '../src/agency-registry/expand.js';

const reg: AgencyRegistry = AgencyRegistry.parse({
  version: 1,
  source: 'test',
  agencies: [
    { id: 'walde', name: 'Walde', website: 'https://walde.ch', canton: 'ZH', platform: 'schemaorg' },
    {
      id: 'nobilis',
      name: 'Nobilis',
      website: 'https://nobilis.ch',
      canton: 'ZH',
      platform: 'casasoft',
      enabled: false,
    },
    { id: 'unknown-fam', name: 'X', website: 'https://x.ch', canton: 'ZH', platform: 'immomig' },
    {
      id: 'zeni',
      name: 'ZENI Immobilien',
      website: 'https://zeni-immobilien.ch',
      canton: 'ZH',
      platform: 'casasoft',
    },
  ],
});

const BUNDLED = new Set(['source-schemaorg']);

describe('expandRegistry', () => {
  it('emits one synthetic entry per enabled row whose platform has a bundled adapter', () => {
    const result = expandRegistry(reg, BUNDLED);
    expect(result.expanded).toHaveLength(2);
    expect(result.expanded[0]?.name).toBe('agency:schemaorg:walde');
    expect(result.expanded[0]?.plugin).toBe('source-schemaorg');
  });

  it('routes casasoft platform through the schemaorg adapter (CasaWP emits JSON-LD)', () => {
    const result = expandRegistry(reg, BUNDLED);
    const zeni = result.expanded.find((e) => e.name === 'agency:casasoft:zeni');
    expect(zeni).toBeDefined();
    expect(zeni?.plugin).toBe('source-schemaorg');
  });

  it('threads regionFilter into each expanded entry inline config when configured', () => {
    const r = expandRegistry(reg, BUNDLED, {
      regionFilter: { postal_codes: ['8008', '8053'], cities: ['Zürich'] },
    });
    const walde = r.expanded.find((e) => e.name === 'agency:schemaorg:walde');
    expect(walde).toBeDefined();
    const b64 = walde!.config.replace(/^inline:/, '');
    const cfg = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    expect(cfg.region_filter).toEqual({
      postal_codes: ['8008', '8053'],
      cities: ['Zürich'],
      cantons: [],
    });
  });

  it('omits region_filter inline when all lists are empty', () => {
    const r = expandRegistry(reg, BUNDLED, {
      regionFilter: { postal_codes: [], cities: [], cantons: [] },
    });
    const walde = r.expanded.find((e) => e.name === 'agency:schemaorg:walde');
    const cfg = JSON.parse(Buffer.from(walde!.config.replace(/^inline:/, ''), 'base64').toString('utf8'));
    expect(cfg.region_filter).toBeUndefined();
  });
  it('skips disabled rows', () => {
    const r = expandRegistry(reg, BUNDLED);
    expect(r.expanded.some((e) => e.name.includes('nobilis'))).toBe(false);
  });
  it('reports unknown-platform rows in `skipped` (never throws)', () => {
    const r = expandRegistry(reg, BUNDLED);
    expect(r.skipped.find((s) => s.id === 'unknown-fam')?.reason).toMatch(/no bundled adapter/);
  });
  it('returns empty arrays for empty registry', () => {
    const r = expandRegistry(AgencyRegistry.parse({ version: 1, source: 'x', agencies: [] }), BUNDLED);
    expect(r.expanded).toEqual([]);
    expect(r.skipped).toEqual([]);
  });
});
