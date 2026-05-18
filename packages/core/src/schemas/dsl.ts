import { z } from 'zod';

/** Comparison operators supported by `field` filter rules. */
export const FilterOp = z.enum(['==', '!=', '>', '>=', '<', '<=', 'in', 'not_in', 'contains', 'regex']);
export type FilterOp = z.infer<typeof FilterOp>;

/** Policy for filter rules when the target field/expression is missing. */
export const OnMissingFilter = z.enum(['fail', 'pass', 'skip']).default('fail');
/** Policy for scoring dimensions when the target metric is missing. */
export const OnMissingDim = z.enum(['zero', 'skip_dim', 'fail']).default('zero');

/** A single filter rule — either a field comparison or a JSONata expression. */
export const FilterRule = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('field'),
    field: z.string(),
    op: FilterOp,
    value: z.unknown(),
    on_missing: OnMissingFilter,
  }),
  z.object({
    kind: z.literal('expr'),
    expr: z.string(),
    on_missing: OnMissingFilter,
  }),
]);
export type FilterRule = z.infer<typeof FilterRule>;

const StepBand = z.object({
  gte: z.number().optional(),
  lt: z.number().optional(),
  eq: z.union([z.string(), z.number()]).optional(),
  else: z.boolean().optional(),
  score: z.number().min(0).max(10),
});

/** Linear interpolation between `best` and `worst`; `invert` is a documentation hint. */
export const NormLinear = z.object({
  type: z.literal('linear'),
  best: z.number(),
  worst: z.number(),
  invert: z.boolean().default(false),
});
/** Piecewise step function evaluated in band order; first match wins. */
export const NormStep = z.object({
  type: z.literal('step'),
  bands: z.array(StepBand).min(1),
});
/** Logistic curve centred at `midpoint` with given `steepness`; `invert` flips direction. */
export const NormSigmoid = z.object({
  type: z.literal('sigmoid'),
  midpoint: z.number(),
  steepness: z.number().positive(),
  invert: z.boolean().default(false),
});
/** Lookup table from stringified raw value to a `[0, 10]` score, with a fallback default. */
export const NormCategorical = z.object({
  type: z.literal('categorical'),
  map: z.record(z.string(), z.number().min(0).max(10)),
  default: z.number().min(0).max(10).default(0),
});
/** Discriminated union of all supported normalisation primitives. */
export const Normalize = z.discriminatedUnion('type', [NormLinear, NormStep, NormSigmoid, NormCategorical]);
export type Normalize = z.infer<typeof Normalize>;

const RuleDim = z.object({
  type: z.literal('rule'),
  name: z.string(),
  weight: z.number().positive(),
  metric: z.string(),
  normalize: Normalize,
  on_missing: OnMissingDim,
});
const LlmDim = z
  .object({
    type: z.literal('llm'),
    name: z.string(),
    weight: z.number().positive(),
    prompt: z.string().optional(),
    prompt_file: z.string().optional(),
  })
  .refine((d) => !!d.prompt !== !!d.prompt_file, { message: 'exactly one of prompt|prompt_file' });

// NOTE: deviated from plan — `z.discriminatedUnion` cannot accept a ZodEffects
// branch (LlmDim uses `.refine(...)`), causing both a TS2345 error and a runtime
// crash. Switched to `z.union` which accepts ZodEffects; runtime discrimination
// still happens via the literal `type` field. Plan bug flagged for revision.
/** A scoring dimension: deterministic rule-based, or LLM-evaluated (not yet implemented). */
export const ScoringDim = z.union([RuleDim, LlmDim]);
export type ScoringDim = z.infer<typeof ScoringDim>;

/** Notification policy: minimum score to dispatch and per-day cap. */
export const NotifyConfig = z.object({
  threshold: z.number().min(0).max(100).default(75),
  daily_quota: z.number().int().positive().default(5),
});
export type NotifyConfig = z.infer<typeof NotifyConfig>;

/** Schema for the `filters.yaml` config file. */
export const FiltersFile = z.object({ filters: z.array(FilterRule) });
/** Schema for the `scoring.yaml` config file (scoring dims + notify policy). */
export const ScoringFile = z.object({ scoring: z.array(ScoringDim).min(1), notify: NotifyConfig });

/** Optional desired-stay constraints for short-term searches. Either bound may be omitted. */
export const StayWindow = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  min_months: z.number().positive().optional(),
  max_months: z.number().positive().optional(),
});
export type StayWindow = z.infer<typeof StayWindow>;

/** Rental-term policy: long vs short, optionally narrowed by a desired stay window. */
export const RentalTermPolicy = z.object({
  mode: z.enum(['long', 'short']),
  exclude_unknown: z.boolean().default(false),
  stay: StayWindow.optional(),
});
export type RentalTermPolicy = z.infer<typeof RentalTermPolicy>;

/** Schema for the `rental_term.yaml` config file. Validates mode/stay coupling. */
export const RentalTermFile = z.object({ rental_term: RentalTermPolicy }).superRefine((data, ctx) => {
  if (data.rental_term.mode === 'long' && data.rental_term.stay) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['rental_term', 'stay'],
      message: 'stay.* is only valid when rental_term.mode === "short"',
    });
  }
});
export type RentalTermFile = z.infer<typeof RentalTermFile>;
