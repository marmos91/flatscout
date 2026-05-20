import { Listing, type RawListing, resolveFields } from '@wabe/core';
import type { WabeDb } from '@wabe/db';

export interface UpsertResult {
  changed: boolean;
  isNew: boolean;
  fingerprint: string;
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
  const nowDate = new Date(now);
  // Defensively stamp raw.first_seen_at/last_seen_at so resolveFields' tie-break
  // and min/max calls operate on real Dates even when the caller (pipeline) didn't.
  const stampedRaw: RawListing = {
    ...raw,
    first_seen_at: raw.first_seen_at ?? nowDate,
    last_seen_at: raw.last_seen_at ?? nowDate,
  };

  // Wrap the entire upsert path in a transaction. better-sqlite3 transactions
  // are synchronous and atomic, so concurrent writers can't observe a partial
  // SELECT-then-INSERT and collide on the PRIMARY KEY.
  return db._raw.transaction((): UpsertResult => {
    const existing = db._raw
      .prepare<[string], { payload: string }>('SELECT payload FROM listings WHERE id = ?')
      .get(ck);

    if (!existing) {
      const next = materialise(stampedRaw, ck, incomingPriority, nowDate);
      insertRow(db, next, now);
      insertFts(db, next);
      return { changed: true, isNew: true, fingerprint: ck };
    }

    const existingListing = Listing.parse(JSON.parse(existing.payload));
    // Stamp raw.id into raw.enriched.external_ids[raw.source] so resolveFields' deep-merge
    // accumulates per-source ids consistently with the materialise() path.
    const rawWithExternalIds: RawListing = stampedRaw.id
      ? {
          ...stampedRaw,
          enriched: {
            ...(stampedRaw.enriched ?? {}),
            external_ids: {
              ...(((stampedRaw.enriched as Record<string, unknown> | undefined)?.external_ids as
                | Record<string, string>
                | undefined) ?? {}),
              [stampedRaw.source]: stampedRaw.id,
            },
          },
        }
      : stampedRaw;
    const { next: merged, changed } = resolveFields(existingListing, rawWithExternalIds, incomingPriority);
    // Keep the persisted JSON payload's last_seen_at consistent with the DB column.
    const next: Listing = { ...merged, last_seen_at: nowDate };

    if (!changed) {
      db._raw.prepare('UPDATE listings SET last_seen_at = ? WHERE id = ?').run(now, ck);
      return { changed: false, isNew: false, fingerprint: ck };
    }

    updateRow(db, next, now);
    updateFts(db, next);
    return { changed: true, isNew: false, fingerprint: ck };
  })();
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

function materialise(raw: RawListing, ck: string, priority: number, now: Date): Listing {
  return Listing.parse({
    ...raw,
    id: ck,
    canonical_key: ck,
    source_priority: priority,
    first_seen_at: raw.first_seen_at ?? now,
    last_seen_at: now,
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
