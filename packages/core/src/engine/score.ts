import type { ScoringDim } from '../schemas/dsl.js';
import { evalJsonata } from './jsonata.js';
import { normalize } from './normalize.js';
import { resolvePath } from './path.js';

export class ScoringFailure extends Error {}
export class NotImplementedError extends Error {}

export type ScoreResult = { final: number; breakdown: Record<string, number> };

export async function scoreListing(dims: ScoringDim[], listing: unknown): Promise<ScoreResult> {
  let sum = 0;
  let weight = 0;
  const breakdown: Record<string, number> = {};
  for (const dim of dims) {
    if (dim.type === 'llm') {
      throw new NotImplementedError(
        `llm scoring dim '${dim.name}' is not implemented in slice; see Phase 3 spec`,
      );
    }
    const raw = await resolveMetric(dim.metric, listing);
    if (raw === undefined) {
      if (dim.on_missing === 'fail') throw new ScoringFailure(`missing metric ${dim.metric} for dim ${dim.name}`);
      if (dim.on_missing === 'skip_dim') continue;
      // 'zero': contribute 0 with full weight
      breakdown[dim.name] = 0;
      weight += dim.weight;
      continue;
    }
    const r = normalize(dim.normalize, raw);
    breakdown[dim.name] = r;
    sum += r * dim.weight;
    weight += dim.weight;
  }
  const final = weight === 0 ? 0 : Math.round((sum / weight) * 100);
  return { final, breakdown };
}

async function resolveMetric(metric: string, listing: unknown): Promise<unknown> {
  if (metric.startsWith('=')) {
    return evalJsonata(metric.slice(1), listing);
  }
  return resolvePath(listing, metric);
}
