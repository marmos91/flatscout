import type { z } from 'zod';
import type { Listing } from '@flatscout/core';
import type { Context } from './context.js';

/** An enricher plugin augments a Listing with extra signals (geocoding, commute, etc). */
export interface Enricher {
  name: string;
  configSchema: z.ZodTypeAny;
  enrich(listing: Listing, ctx: Context): Promise<Listing>;
}
