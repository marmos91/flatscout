import type { Listing } from '@wabe/core';
import type { WabeDb } from '@wabe/db';

export interface DedupVerdict {
  /** When true, the pipeline must NOT notify this listing — a higher-priority canonical duplicate already exists. */
  suppress: boolean;
  /** Names of OTHER sources in the same canonical group, sorted, for the notifier's "Also on:" footer. Empty when this is the first arrival or the only source. */
  also_seen_on: string[];
}

/**
 * Notify-time cross-source dedup check.
 *
 * Looks up other listings sharing this listing's `canonical_key`. If any has
 * a strictly higher `source_priority`, suppress this notification (the winner
 * has already been or will be notified separately). If this listing wins or
 * ties on top priority, allow notification and report the other sources so
 * the notifier can render an "Also on:" footer.
 *
 * Ties: when multiple sources share the highest priority within a group, the
 * first to arrive notifies; subsequent same-priority arrivals are suppressed.
 * The first-arrival check is by `first_seen_at` in the persisted row.
 */
export function shouldNotify(db: WabeDb, listing: Listing): DedupVerdict {
  const rows = db._raw
    .prepare<[string], { id: string; source: string; source_priority: number; first_seen_at: number }>(
      'SELECT id, source, source_priority, first_seen_at FROM listings WHERE canonical_key = ?',
    )
    .all(listing.canonical_key);
  const others = rows.filter((r) => r.id !== listing.id);
  const maxOtherPriority = others.reduce((m, r) => Math.max(m, r.source_priority), -1);
  if (maxOtherPriority > listing.source_priority) {
    return { suppress: true, also_seen_on: [] };
  }
  if (maxOtherPriority === listing.source_priority && others.length > 0) {
    const self = rows.find((r) => r.id === listing.id);
    const olderTie = others.some(
      (r) =>
        r.source_priority === listing.source_priority &&
        self !== undefined &&
        r.first_seen_at < self.first_seen_at,
    );
    if (olderTie) return { suppress: true, also_seen_on: [] };
  }
  const alsoSeen = Array.from(new Set(others.map((r) => r.source))).sort();
  return { suppress: false, also_seen_on: alsoSeen };
}
