import { describe, expect, it } from 'vitest';
import { evaluateFilters } from '../src/engine/filter.js';
import type { FilterRule } from '../src/schemas/dsl.js';

const listing = {
  rooms: 4,
  price: { total: 2800 },
  location: { city: 'Zürich', neighborhood: 'Witikon' },
  features: { garden: true },
  floor: 2,
};

describe('evaluateFilters', () => {
  it('passes when all field filters match', async () => {
    const filters: FilterRule[] = [
      { kind: 'field', field: 'rooms', op: '>=', value: 3.5, on_missing: 'fail' },
      { kind: 'field', field: 'price.total', op: '<=', value: 3000, on_missing: 'fail' },
      { kind: 'field', field: 'location.neighborhood', op: 'in', value: ['Witikon'], on_missing: 'fail' },
    ];
    expect(await evaluateFilters(filters, listing)).toEqual({ passed: true });
  });

  it('fails on first non-matching filter', async () => {
    const filters: FilterRule[] = [{ kind: 'field', field: 'rooms', op: '>=', value: 5, on_missing: 'fail' }];
    const r = await evaluateFilters(filters, listing);
    expect(r.passed).toBe(false);
    if (!r.passed) expect(r.reason).toContain('rooms');
  });

  it('respects on_missing=pass for absent field', async () => {
    const filters: FilterRule[] = [
      { kind: 'field', field: 'doesnt.exist', op: '==', value: 1, on_missing: 'pass' },
    ];
    expect((await evaluateFilters(filters, listing)).passed).toBe(true);
  });

  it('respects on_missing=skip for absent field (silently ignores)', async () => {
    const filters: FilterRule[] = [
      { kind: 'field', field: 'doesnt.exist', op: '==', value: 1, on_missing: 'skip' },
    ];
    expect((await evaluateFilters(filters, listing)).passed).toBe(true);
  });

  it('evaluates expr filter (JSONata)', async () => {
    const filters: FilterRule[] = [
      { kind: 'expr', expr: 'floor > 0 or features.garden', on_missing: 'fail' },
    ];
    expect((await evaluateFilters(filters, listing)).passed).toBe(true);
  });

  it('supports in and not_in ops', async () => {
    expect(
      (
        await evaluateFilters(
          [{ kind: 'field', field: 'rooms', op: 'not_in', value: [3, 4], on_missing: 'fail' }],
          listing,
        )
      ).passed,
    ).toBe(false);
  });

  it('supports contains for strings and arrays', async () => {
    expect(
      (
        await evaluateFilters(
          [{ kind: 'field', field: 'location.city', op: 'contains', value: 'üri', on_missing: 'fail' }],
          listing,
        )
      ).passed,
    ).toBe(true);
  });

  it('supports regex op', async () => {
    expect(
      (
        await evaluateFilters(
          [{ kind: 'field', field: 'location.city', op: 'regex', value: '^Z', on_missing: 'fail' }],
          listing,
        )
      ).passed,
    ).toBe(true);
  });
});
