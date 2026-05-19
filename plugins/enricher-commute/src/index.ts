import type { Enricher, Context } from '@wabe/plugin-sdk';
import type { Listing } from '@wabe/core';
import type Database from 'better-sqlite3';
import { CommuteConfig } from './schemas.js';
import { enrichCommute } from './enrich.js';

const plugin: Enricher = {
  name: 'enricher-commute',
  configSchema: CommuteConfig,
  async enrich(listing: Listing, ctx: Context): Promise<Listing> {
    const cfg = CommuteConfig.parse(ctx.config);
    const dbHandle = (ctx.db as { _raw?: Database.Database } | undefined)?._raw;
    if (!dbHandle) {
      ctx.logger.warn({ listing_id: listing.id }, 'enricher-commute: missing db._raw; returning listing unchanged');
      return listing;
    }
    return enrichCommute(listing, cfg, dbHandle, ctx.logger, ctx.signal);
  },
};

export default { kind: 'enricher' as const, plugin };
export { CommuteConfig, CommutePayload } from './schemas.js';
