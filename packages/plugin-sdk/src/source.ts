import type { z } from 'zod';
import type { RawListing } from '@wabe/core';
import type { Context } from './context.js';

/**
 * A source plugin streams raw listings from an external provider.
 *
 * `fetch` is an async iterable so plugins can yield as they paginate, letting
 * the orchestrator persist / filter / score each item incrementally instead of
 * waiting for a full crawl to complete.
 */
export interface Source {
  name: string;
  configSchema: z.ZodTypeAny;
  fetch(ctx: Context): AsyncIterable<RawListing>;
}

export type { RawListing };
