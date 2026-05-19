import type { CommutePrimitive, ScoringDim } from '../schemas/dsl.js';
import { evalJsonata } from './jsonata.js';
import { normalize } from './normalize.js';
import { resolvePath } from './path.js';

/** Thrown when a scoring dimension's metric is missing and `on_missing: 'fail'`. */
export class ScoringFailure extends Error {}
/** Thrown when a `type: 'llm'` scoring dimension is encountered; LLM scoring is out-of-slice. */
export class NotImplementedError extends Error {}

export type ScoreResult = { final: number; breakdown: Record<string, number> };

/**
 * Computes a weighted score for a listing across a set of scoring dimensions.
 *
 * For each `rule` dim: resolves `metric` (a dotted path, or a JSONata expression
 * if prefixed with `=`), normalises the raw value via `normalize()`, and adds
 * `normalized * weight` to the running sum. Missing metrics route through
 * `on_missing`: `'zero'` contributes 0 with full weight (lowers final score),
 * `'skip_dim'` drops the dim entirely (does not affect the weighted average),
 * `'fail'` throws `ScoringFailure`.
 *
 * The final score is `round((sum / total_weight) * 100)`, in `[0, 100]`. Empty
 * or all-skipped weights yield 0. The `breakdown` map records each contributing
 * dim's normalised `[0, 1]` value for explainability.
 *
 * @throws ScoringFailure when a required metric is missing.
 * @throws NotImplementedError when a `type: 'llm'` dim is supplied.
 */
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
      if (dim.on_missing === 'fail')
        throw new ScoringFailure(
          `missing metric ${typeof dim.metric === 'object' ? JSON.stringify(dim.metric) : dim.metric} for dim ${dim.name}`,
        );
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

async function resolveMetric(metric: string | CommutePrimitive, listing: unknown): Promise<unknown> {
  if (typeof metric === 'object' && metric !== null && 'kind' in metric && metric.kind === 'commute') {
    const root = listing as {
      enriched?: { commute?: Record<string, Record<string, { duration_min?: number }>> };
    };
    const cell = root.enriched?.commute?.[metric.target]?.[metric.mode];
    return typeof cell?.duration_min === 'number' ? cell.duration_min : undefined;
  }
  if (typeof metric === 'string') {
    if (metric.startsWith('=')) {
      return evalJsonata(metric.slice(1), listing);
    }
    return resolvePath(listing, metric);
  }
  return undefined;
}
