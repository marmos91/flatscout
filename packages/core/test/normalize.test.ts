import { describe, expect, it } from 'vitest';
import { normalize } from '../src/engine/normalize.js';

describe('normalize', () => {
  it('linear maps best→1, worst→0', () => {
    expect(normalize({ type: 'linear', best: 10, worst: 0, invert: false }, 10)).toBeCloseTo(1);
    expect(normalize({ type: 'linear', best: 10, worst: 0, invert: false }, 0)).toBeCloseTo(0);
    expect(normalize({ type: 'linear', best: 10, worst: 0, invert: false }, 5)).toBeCloseTo(0.5);
  });
  it('linear clamps outside range', () => {
    expect(normalize({ type: 'linear', best: 10, worst: 0, invert: false }, 100)).toBeCloseTo(1);
    expect(normalize({ type: 'linear', best: 10, worst: 0, invert: false }, -5)).toBeCloseTo(0);
  });
  it('linear with invert swaps roles', () => {
    expect(normalize({ type: 'linear', best: 2000, worst: 4000, invert: true }, 2000)).toBeCloseTo(1);
    expect(normalize({ type: 'linear', best: 2000, worst: 4000, invert: true }, 4000)).toBeCloseTo(0);
    expect(normalize({ type: 'linear', best: 2000, worst: 4000, invert: true }, 3000)).toBeCloseTo(0.5);
  });
  it('step picks first matching band, divides by 10', () => {
    const n = (x: number) =>
      normalize(
        {
          type: 'step',
          bands: [
            { gte: 2015, score: 10 },
            { gte: 1970, score: 5 },
            { gte: 1900, score: 7 },
            { else: true, score: 4 },
          ],
        },
        x,
      );
    expect(n(2020)).toBeCloseTo(1);
    expect(n(1980)).toBeCloseTo(0.5);
    expect(n(1910)).toBeCloseTo(0.7);
    expect(n(1850)).toBeCloseTo(0.4);
  });
  it('step supports lt and eq bands', () => {
    expect(
      normalize(
        {
          type: 'step',
          bands: [
            { lt: 0, score: 0 },
            { eq: 0, score: 5 },
            { else: true, score: 10 },
          ],
        },
        0,
      ),
    ).toBeCloseTo(0.5);
  });
  it('sigmoid: midpoint → 0.5, large positive → near 1', () => {
    expect(normalize({ type: 'sigmoid', midpoint: 0, steepness: 1, invert: false }, 0)).toBeCloseTo(0.5);
    expect(normalize({ type: 'sigmoid', midpoint: 0, steepness: 1, invert: false }, 10)).toBeGreaterThan(
      0.99,
    );
    expect(normalize({ type: 'sigmoid', midpoint: 0, steepness: 1, invert: false }, -10)).toBeLessThan(0.01);
  });
  it('sigmoid with invert flips', () => {
    expect(normalize({ type: 'sigmoid', midpoint: 0, steepness: 1, invert: true }, 10)).toBeLessThan(0.01);
  });
  it('categorical maps value via map, divides by 10', () => {
    expect(normalize({ type: 'categorical', map: { S: 10, N: 2 }, default: 4 }, 'S')).toBeCloseTo(1);
    expect(normalize({ type: 'categorical', map: { S: 10, N: 2 }, default: 4 }, 'XX')).toBeCloseTo(0.4);
  });
});
