import type { z } from 'zod';
import type { RawListing } from '@wabe/core';
import type { Context } from './context.js';

export interface Source {
  name: string;
  configSchema: z.ZodTypeAny;
  fetch(ctx: Context): AsyncIterable<RawListing>;
}

export type { RawListing };
