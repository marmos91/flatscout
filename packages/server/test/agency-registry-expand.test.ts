import { describe, expect, it } from 'vitest';
import { AgencyRegistry } from '@wabe/core';
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
  ],
});

const BUNDLED = new Set(['source-schemaorg']);

describe('expandRegistry', () => {
  it('emits one synthetic entry per enabled row whose platform has a bundled adapter', () => {
    const result = expandRegistry(reg, BUNDLED);
    expect(result.expanded).toHaveLength(1);
    expect(result.expanded[0]?.name).toBe('agency:schemaorg:walde');
    expect(result.expanded[0]?.plugin).toBe('source-schemaorg');
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
