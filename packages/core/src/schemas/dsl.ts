import { z } from 'zod';

export const FilterOp = z.enum(['==', '!=', '>', '>=', '<', '<=', 'in', 'not_in', 'contains', 'regex']);
export type FilterOp = z.infer<typeof FilterOp>;

export const OnMissingFilter = z.enum(['fail', 'pass', 'skip']).default('fail');
export const OnMissingDim = z.enum(['zero', 'skip_dim', 'fail']).default('zero');

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

export const NormLinear = z.object({
  type: z.literal('linear'),
  best: z.number(),
  worst: z.number(),
  invert: z.boolean().default(false),
});
export const NormStep = z.object({
  type: z.literal('step'),
  bands: z.array(StepBand).min(1),
});
export const NormSigmoid = z.object({
  type: z.literal('sigmoid'),
  midpoint: z.number(),
  steepness: z.number().positive(),
  invert: z.boolean().default(false),
});
export const NormCategorical = z.object({
  type: z.literal('categorical'),
  map: z.record(z.string(), z.number().min(0).max(10)),
  default: z.number().min(0).max(10).default(0),
});
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
export const ScoringDim = z.union([RuleDim, LlmDim]);
export type ScoringDim = z.infer<typeof ScoringDim>;

export const NotifyConfig = z.object({
  threshold: z.number().min(0).max(100).default(75),
  daily_quota: z.number().int().positive().default(5),
});
export type NotifyConfig = z.infer<typeof NotifyConfig>;

export const FiltersFile = z.object({ filters: z.array(FilterRule) });
export const ScoringFile = z.object({ scoring: z.array(ScoringDim).min(1), notify: NotifyConfig });
