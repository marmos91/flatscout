import type { Enricher } from '@wabe/plugin-sdk';
import type { Listing } from '@wabe/core';
import { CommuteConfig } from './schemas.js';

const plugin: Enricher = {
  name: 'enricher-commute',
  configSchema: CommuteConfig,
  async enrich(listing: Listing): Promise<Listing> {
    return listing;
  },
};

export default { kind: 'enricher' as const, plugin };
export { CommuteConfig, CommutePayload } from './schemas.js';
