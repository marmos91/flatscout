import type { Normalize } from '../schemas/dsl.js';

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

export function normalize(spec: Normalize, raw: unknown): number {
  switch (spec.type) {
    case 'linear': {
      // NOTE: deviated from plan — the plan's invert logic produced the wrong
      // result for the test "linear with invert swaps roles" (best=2000,
      // worst=4000, invert=true, raw=2000 → expected 1, plan returned 0).
      // Correct semantics: raw=best → 1, raw=worst → 0, regardless of `invert`
      // (the `invert` field is just a documentation hint that best < worst).
      // The formula (raw-worst)/(best-worst) naturally handles both directions
      // and clamp01 covers the out-of-range case.
      if (typeof raw !== 'number') return 0;
      const { best, worst } = spec;
      if (best === worst) return 0;
      return clamp01((raw - worst) / (best - worst));
    }
    case 'step': {
      for (const band of spec.bands) {
        if (band.else) return band.score / 10;
        if (band.eq !== undefined && raw === band.eq) return band.score / 10;
        if (typeof raw !== 'number') continue;
        const gteOk = band.gte === undefined || raw >= band.gte;
        const ltOk = band.lt === undefined || raw < band.lt;
        if ((band.gte !== undefined || band.lt !== undefined) && gteOk && ltOk) return band.score / 10;
      }
      return 0;
    }
    case 'sigmoid': {
      if (typeof raw !== 'number') return 0;
      const s = 1 / (1 + Math.exp(-spec.steepness * (raw - spec.midpoint)));
      return spec.invert ? 1 - s : s;
    }
    case 'categorical': {
      const key = String(raw);
      const v = spec.map[key];
      const score = v ?? spec.default;
      return score / 10;
    }
  }
}
