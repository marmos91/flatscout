import { describe, it, expect } from 'vitest';
import { FilterRule, RuleDim, CommutePrimitive, CommuteMode } from '../src/schemas/dsl.js';

describe('CommutePrimitive', () => {
  it('parses a valid primitive', () => {
    const p = CommutePrimitive.parse({ kind: 'commute', target: 'work', mode: 'transit' });
    expect(p).toEqual({ kind: 'commute', target: 'work', mode: 'transit' });
  });
  it('rejects unknown mode', () => {
    expect(() => CommutePrimitive.parse({ kind: 'commute', target: 'work', mode: 'magic' })).toThrow();
  });
});

describe('CommuteMode', () => {
  it('enumerates the four supported modes', () => {
    expect(CommuteMode.options).toEqual(['transit', 'cycling', 'walking', 'driving']);
  });
});

describe('FilterRule commute branch', () => {
  it('parses a commute filter rule', () => {
    const r = FilterRule.parse({
      kind: 'commute',
      target: 'work',
      mode: 'transit',
      op: '<=',
      value: 30,
      on_missing: 'fail',
    });
    expect(r.kind).toBe('commute');
  });
  it('rejects non-numeric value for commute filter', () => {
    expect(() =>
      FilterRule.parse({ kind: 'commute', target: 'work', mode: 'transit', op: '<=', value: 'soon' }),
    ).toThrow();
  });
});

describe('RuleDim.metric commute primitive', () => {
  it('accepts a CommutePrimitive in metric', () => {
    const d = RuleDim.parse({
      type: 'rule',
      name: 'work_commute',
      weight: 0.4,
      metric: { kind: 'commute', target: 'work', mode: 'transit' },
      normalize: { type: 'linear', best: 0, worst: 60 },
    });
    expect(d.metric).toEqual({ kind: 'commute', target: 'work', mode: 'transit' });
  });
  it('still accepts a string metric (back-compat)', () => {
    const d = RuleDim.parse({
      type: 'rule',
      name: 'price',
      weight: 0.3,
      metric: 'price.total',
      normalize: { type: 'linear', best: 1000, worst: 4000 },
    });
    expect(d.metric).toBe('price.total');
  });
});
