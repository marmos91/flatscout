import type { z } from 'zod';
import type { Listing } from '@wabe/core';
import type { Context } from './context.js';

export interface ScoreResult {
  final: number;
  breakdown: Record<string, number>;
}

export interface Scorer {
  name: string;
  configSchema: z.ZodTypeAny;
  score(listing: Listing, ctx: Context): Promise<ScoreResult>;
}
