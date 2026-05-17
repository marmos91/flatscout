import { describe, expect, it } from 'vitest';
import { FilterRule, ScoringDim, NotifyConfig } from '../src/schemas/dsl.js';

describe('FilterRule', () => {
  it('accepts a field rule', () => {
    expect(FilterRule.parse({ kind: 'field', field: 'rooms', op: '>=', value: 3.5 })).toMatchObject({
      kind: 'field',
      on_missing: 'fail',
    });
  });
  it('accepts an expr rule', () => {
    expect(FilterRule.parse({ kind: 'expr', expr: 'rooms > 3' })).toMatchObject({
      kind: 'expr',
      on_missing: 'fail',
    });
  });
  it('rejects unknown kind', () => {
    expect(() => FilterRule.parse({ kind: 'nope', field: 'x', op: '==', value: 1 })).toThrow();
  });
  it('rejects unknown op', () => {
    expect(() => FilterRule.parse({ kind: 'field', field: 'x', op: '~~', value: 1 })).toThrow();
  });
});

describe('ScoringDim', () => {
  it('accepts a rule dim with linear normalize', () => {
    const dim = ScoringDim.parse({
      type: 'rule',
      name: 'price',
      weight: 10,
      metric: 'price.total',
      normalize: { type: 'linear', best: 2000, worst: 4000, invert: true },
    });
    expect(dim).toMatchObject({ type: 'rule', on_missing: 'zero' });
  });
  it('accepts a step normalize with mixed band shapes', () => {
    const dim = ScoringDim.parse({
      type: 'rule',
      name: 'year',
      weight: 5,
      metric: 'built_year',
      normalize: { type: 'step', bands: [{ gte: 2015, score: 10 }, { else: true, score: 4 }] },
    });
    if (dim.type !== 'rule') throw new Error('expected rule');
    if (dim.normalize.type !== 'step') throw new Error('expected step');
    expect(dim.normalize.bands).toHaveLength(2);
  });
  it('accepts an llm dim with prompt_file', () => {
    expect(
      ScoringDim.parse({ type: 'llm', name: 'vibe', weight: 30, prompt_file: 'p.md' }),
    ).toMatchObject({ type: 'llm' });
  });
  it('rejects an llm dim with both prompt and prompt_file', () => {
    expect(() =>
      ScoringDim.parse({ type: 'llm', name: 'vibe', weight: 30, prompt: 'a', prompt_file: 'p.md' }),
    ).toThrow();
  });
  it('rejects an llm dim with neither prompt nor prompt_file', () => {
    expect(() => ScoringDim.parse({ type: 'llm', name: 'vibe', weight: 30 })).toThrow();
  });
});

describe('NotifyConfig', () => {
  it('applies defaults', () => {
    expect(NotifyConfig.parse({})).toEqual({ threshold: 75, daily_quota: 5 });
  });
});
