import { describe, expect, it } from 'vitest';
import { scoreListing } from '../src/engine/score.js';
import type { ScoringDim } from '../src/schemas/dsl.js';

const listing = {
  rooms: 4,
  price: { total: 3000 },
  built_year: 1985,
  features: { balcony: { orientation: 'S' } },
};

describe('scoreListing', () => {
  it('throws NotImplementedError on llm dim', async () => {
    const dims: ScoringDim[] = [{ type: 'llm', name: 'vibe', weight: 10, prompt: 'rate it' } as never];
    await expect(scoreListing(dims, listing)).rejects.toThrow(/llm.*not implemented/i);
  });

  it('weighted-sum across rule dims, returns 0..100', async () => {
    const dims: ScoringDim[] = [
      {
        type: 'rule',
        name: 'price',
        weight: 15,
        metric: 'price.total',
        on_missing: 'zero',
        normalize: { type: 'linear', best: 2000, worst: 4000, invert: true },
      },
      {
        type: 'rule',
        name: 'year',
        weight: 10,
        metric: 'built_year',
        on_missing: 'zero',
        normalize: {
          type: 'step',
          bands: [
            { gte: 2015, score: 10 },
            { gte: 1970, score: 5 },
            { else: true, score: 4 },
          ],
        },
      },
    ];
    const r = await scoreListing(dims, listing);
    // price raw = 0.5 * 15 = 7.5; year raw = 0.5 * 10 = 5; total = 12.5 / 25 = 0.5 → 50
    expect(r.final).toBe(50);
    expect(r.breakdown.price).toBeCloseTo(0.5);
    expect(r.breakdown.year).toBeCloseTo(0.5);
  });

  it('on_missing=skip_dim drops dim from both sums', async () => {
    const dims: ScoringDim[] = [
      {
        type: 'rule',
        name: 'price',
        weight: 15,
        metric: 'price.total',
        on_missing: 'zero',
        normalize: { type: 'linear', best: 2000, worst: 4000, invert: true },
      },
      {
        type: 'rule',
        name: 'missing',
        weight: 100,
        metric: 'doesnt.exist',
        on_missing: 'skip_dim',
        normalize: { type: 'linear', best: 0, worst: 10, invert: false },
      },
    ];
    const r = await scoreListing(dims, listing);
    expect(r.final).toBe(50); // missing dim skipped → price alone = 0.5 → 50
  });

  it('on_missing=zero keeps weight, contributes 0', async () => {
    const dims: ScoringDim[] = [
      {
        type: 'rule',
        name: 'a',
        weight: 50,
        metric: 'price.total',
        on_missing: 'zero',
        normalize: { type: 'linear', best: 2000, worst: 4000, invert: true },
      },
      {
        type: 'rule',
        name: 'b',
        weight: 50,
        metric: 'doesnt.exist',
        on_missing: 'zero',
        normalize: { type: 'linear', best: 0, worst: 10, invert: false },
      },
    ];
    const r = await scoreListing(dims, listing);
    expect(r.final).toBe(25); // (0.5*50 + 0*50) / 100 = 0.25 → 25
  });

  it('on_missing=fail raises ScoringFailure', async () => {
    const dims: ScoringDim[] = [
      {
        type: 'rule',
        name: 'x',
        weight: 10,
        metric: 'doesnt.exist',
        on_missing: 'fail',
        normalize: { type: 'linear', best: 0, worst: 1, invert: false },
      },
    ];
    await expect(scoreListing(dims, listing)).rejects.toThrow(/missing.*doesnt\.exist/);
  });

  it('supports JSONata in metric via = prefix', async () => {
    const dims: ScoringDim[] = [
      {
        type: 'rule',
        name: 'derived',
        weight: 1,
        metric: '=rooms * 1000',
        on_missing: 'zero',
        normalize: { type: 'linear', best: 4000, worst: 2000, invert: false },
      },
    ];
    const r = await scoreListing(dims, listing); // rooms*1000=4000 → top of range → 1
    expect(r.breakdown.derived).toBeCloseTo(1);
  });

  it('uses categorical for nested string', async () => {
    const dims: ScoringDim[] = [
      {
        type: 'rule',
        name: 'orient',
        weight: 1,
        metric: 'features.balcony.orientation',
        on_missing: 'zero',
        normalize: { type: 'categorical', map: { S: 10, N: 2 }, default: 4 },
      },
    ];
    const r = await scoreListing(dims, listing);
    expect(r.breakdown.orient).toBeCloseTo(1);
  });
});

describe('scoring - commute primitive metric', () => {
  const listing = {
    id: 'a',
    source: 's',
    url: 'https://x/a',
    price: { rent_net: 2000, total: 2200, extras: 200, currency: 'CHF', deposit_months: 2 },
    rooms: 3,
    area_m2: 70,
    location: { coords: null, address: null, postal_code: null, city: null, region: null, country: 'CH', neighborhood: null },
    enriched: { commute: { work: { transit: { duration_min: 20, distance_km: 6, computed_at: new Date() } } } },
  };

  it('resolves commute primitive to minutes', async () => {
    const score = await scoreListing(
      [{
        type: 'rule', name: 'work', weight: 1,
        metric: { kind: 'commute', target: 'work', mode: 'transit' },
        normalize: { type: 'linear', best: 0, worst: 60, invert: false },
        on_missing: 'zero',
      }],
      listing,
    );
    // Linear at 20 between best=0 (score 10) and worst=60 (score 0): normalized ≈ 0.667; final ≈ 67
    expect(score.final).toBeGreaterThan(60);
    expect(score.final).toBeLessThan(75);
  });

  it('uses on_missing:zero when target absent', async () => {
    const score = await scoreListing(
      [{
        type: 'rule', name: 'gym', weight: 1,
        metric: { kind: 'commute', target: 'gym', mode: 'transit' },
        normalize: { type: 'linear', best: 0, worst: 60, invert: false },
        on_missing: 'zero',
      }],
      listing,
    );
    expect(score.final).toBe(0);
  });
});
