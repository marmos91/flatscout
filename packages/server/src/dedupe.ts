import { Listing, type RawListing, canonicalKey, resolveFields } from '@wabe/core';
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
 *
 * LEGACY: removed in Task 4 once pipeline.ts migrates to mergeUpsertCanonical.
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

/**
 * Upserts a RawListing into the collapsed `listings` table where `id == canonical_key`.
 *
 * - No row at ck: materialise a fresh Listing from `raw` (id=ck), INSERT, return isNew=true.
 * - Row exists: fold `raw` through `resolveFields` against the existing payload.
 *   UPDATE only if `changed`. `isNew` is always false on an existing row.
 *
 * Returns `{ isNew, changed, fingerprint }`. `fingerprint` mirrors the new row's id
 * for downstream logging compatibility.
 */
export function mergeUpsertCanonical(
  db: WabeDb,
  raw: RawListing,
  ck: string,
  incomingPriority: number,
): UpsertResult {
  const now = Date.now();
  const existing = db._raw
    .prepare<[string], { payload: string }>('SELECT payload FROM listings WHERE id = ?')
    .get(ck);

  if (!existing) {
    const next = materialise(raw, ck, incomingPriority);
    insertRow(db, next, now);
    insertFts(db, next);
    return { changed: true, isNew: true, fingerprint: ck };
  }

  const existingListing = Listing.parse(JSON.parse(existing.payload));
  // Stamp raw.id into raw.enriched.external_ids[raw.source] so resolveFields' deep-merge
  // accumulates per-source ids consistently with the materialise() path.
  const rawWithExternalIds: RawListing = raw.id
    ? {
        ...raw,
        enriched: {
          ...(raw.enriched ?? {}),
          external_ids: {
            ...(((raw.enriched as Record<string, unknown> | undefined)?.external_ids as
              | Record<string, string>
              | undefined) ?? {}),
            [raw.source]: raw.id,
          },
        },
      }
    : raw;
  const { next, changed } = resolveFields(existingListing, rawWithExternalIds, incomingPriority);

  if (!changed) {
    db._raw.prepare('UPDATE listings SET last_seen_at = ? WHERE id = ?').run(now, ck);
    return { changed: false, isNew: false, fingerprint: ck };
  }

  updateRow(db, next, now);
  updateFts(db, next);
  return { changed: true, isNew: false, fingerprint: ck };
}

/** Overwrite a known canonical row's payload — used by the enricher stage. */
export function writeListingPayload(db: WabeDb, listing: Listing): void {
  const now = Date.now();
  updateRow(db, listing, now);
  updateFts(db, listing);
}

/** Read the materialised canonical row by canonical_key (= id). */
export function readListing(db: WabeDb, ck: string): Listing | null {
  const row = db._raw
    .prepare<[string], { payload: string }>('SELECT payload FROM listings WHERE id = ?')
    .get(ck);
  return row ? Listing.parse(JSON.parse(row.payload)) : null;
}

function materialise(raw: RawListing, ck: string, priority: number): Listing {
  return Listing.parse({
    ...raw,
    id: ck,
    canonical_key: ck,
    source_priority: priority,
    first_seen_at: raw.first_seen_at ?? new Date(),
    last_seen_at: raw.last_seen_at ?? new Date(),
    seen_on_sources: [raw.source],
    enriched: {
      ...(raw.enriched ?? {}),
      external_ids: {
        ...(((raw.enriched as Record<string, unknown> | undefined)?.external_ids as
          | Record<string, string>
          | undefined) ?? {}),
        ...(raw.id ? { [raw.source]: raw.id } : {}),
      },
    },
  });
}

function insertRow(db: WabeDb, l: Listing, now: number): void {
  db._raw
    .prepare(
      'INSERT INTO listings (id,source,url,fingerprint,payload,first_seen_at,last_seen_at,status,canonical_key,source_priority,seen_on_sources) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      l.id,
      l.source,
      l.url,
      l.id,
      JSON.stringify(l),
      l.first_seen_at.getTime(),
      now,
      'new',
      l.canonical_key,
      l.source_priority,
      JSON.stringify(l.seen_on_sources),
    );
}

function updateRow(db: WabeDb, l: Listing, now: number): void {
  db._raw
    .prepare(
      'UPDATE listings SET source=?, url=?, payload=?, last_seen_at=?, source_priority=?, seen_on_sources=? WHERE id=?',
    )
    .run(l.source, l.url, JSON.stringify(l), now, l.source_priority, JSON.stringify(l.seen_on_sources), l.id);
}

function insertFts(db: WabeDb, l: Listing): void {
  db._raw.prepare('INSERT INTO listings_fts (id, description) VALUES (?, ?)').run(l.id, l.description ?? '');
}

function updateFts(db: WabeDb, l: Listing): void {
  db._raw.prepare('DELETE FROM listings_fts WHERE id = ?').run(l.id);
  insertFts(db, l);
}
