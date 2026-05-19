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
  /**
   * Optional. Called once when the pipeline shuts down (clean exit, abrupt
   * shutdown signal, or test teardown). Implementations should release any held
   * resources (open WebSockets, file descriptors, child processes, timers). Errors
   * are logged but do not block shutdown of other plugins.
   */
  dispose?(): Promise<void>;
}

export type { RawListing };
