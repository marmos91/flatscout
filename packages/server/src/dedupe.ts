import type { Listing } from '@wabe/core';
import { canonicalKey } from '@wabe/core';
import type { WabeDb } from '@wabe/db';

export interface UpsertResult {
  changed: boolean;
  isNew: boolean;
  fingerprint: string;
}

/**
 * Inserts a listing or updates the existing row if its serialised payload has
 * changed. Stamps `canonical_key` from bucketed fields and persists
 * `source_priority` + `seen_on_sources` so the notify-time dedup check can
 * find the canonical group.
 */
export function upsertListing(db: WabeDb, listing: Listing): UpsertResult {
  const now = Date.now();
  const fingerprint = listing.id;
  // Stamp canonical_key if pipeline left it empty (it should always be empty here — pipeline computes after enrich).
  const ck =
    listing.canonical_key && listing.canonical_key.length > 0
      ? listing.canonical_key
      : canonicalKey({
          postal_code: listing.location.postal_code,
          rooms: listing.rooms,
          area_m2: listing.area_m2,
          price_total: listing.price.total,
          url: listing.url,
        });
  const stamped: Listing = { ...listing, canonical_key: ck };

  // Merge seen_on_sources across any existing rows with the same canonical_key.
  const sourcesForGroup = db._raw
    .prepare<[string], { source: string }>('SELECT DISTINCT source FROM listings WHERE canonical_key = ?')
    .all(ck)
    .map((r) => r.source);
  const mergedSources = Array.from(new Set([...sourcesForGroup, stamped.source])).sort();
  const finalListing: Listing = { ...stamped, seen_on_sources: mergedSources };
  const payload = JSON.stringify(finalListing);

  const existing = db._raw
    .prepare<[string], { id: string; payload: string }>('SELECT id, payload FROM listings WHERE id = ?')
    .get(finalListing.id);

  if (!existing) {
    db._raw
      .prepare(
        'INSERT INTO listings (id,source,url,fingerprint,payload,first_seen_at,last_seen_at,status,canonical_key,source_priority,seen_on_sources) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        finalListing.id,
        finalListing.source,
        finalListing.url,
        fingerprint,
        payload,
        now,
        now,
        'new',
        ck,
        finalListing.source_priority,
        JSON.stringify(mergedSources),
      );
    // Also backfill seen_on_sources on existing rows in the same group (so the older row "knows" the newer source has joined).
    db._raw
      .prepare('UPDATE listings SET seen_on_sources = ? WHERE canonical_key = ? AND id != ?')
      .run(JSON.stringify(mergedSources), ck, finalListing.id);
    return { changed: true, isNew: true, fingerprint };
  }
  if (existing.payload === payload) {
    db._raw.prepare('UPDATE listings SET last_seen_at = ? WHERE id = ?').run(now, finalListing.id);
    return { changed: false, isNew: false, fingerprint };
  }
  db._raw
    .prepare(
      'UPDATE listings SET payload = ?, last_seen_at = ?, canonical_key = ?, source_priority = ?, seen_on_sources = ? WHERE id = ?',
    )
    .run(payload, now, ck, finalListing.source_priority, JSON.stringify(mergedSources), finalListing.id);
  return { changed: true, isNew: false, fingerprint };
}
