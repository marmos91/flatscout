import type { Listing } from '@flatscout/core';
import type { UpsertResult } from './dedupe.js';

export interface DedupVerdict {
  /** True when the canonical row already existed before this scan (notify must NOT fire). */
  suppress: boolean;
  /** Other sources that have contributed to this canonical row (for the "Also on:" footer). */
  also_seen_on: string[];
}

/**
 * Notify-time cross-source dedup verdict. Pure function — derives from the
 * upsert outcome and the merged listing's `seen_on_sources` / authoritative
 * source. Notification fires once per canonical row, on its first INSERT.
 */
export function shouldNotify(upsertResult: UpsertResult, listing: Listing): DedupVerdict {
  if (upsertResult.isNew) {
    return { suppress: false, also_seen_on: [] };
  }
  return {
    suppress: true,
    also_seen_on: listing.seen_on_sources.filter((s) => s !== listing.source).sort(),
  };
}
