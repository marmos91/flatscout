import type { z } from 'zod';
import type { Listing } from '@wabe/core';
import type { Context } from './context.js';

export interface Enricher {
  name: string;
  configSchema: z.ZodTypeAny;
  enrich(listing: Listing, ctx: Context): Promise<Listing>;
}
