import type { Listing } from '@wabe/core';
import type { WabeDb } from '@wabe/db';

export interface UpsertResult {
  changed: boolean;
  isNew: boolean;
  fingerprint: string;
}

export function upsertListing(db: WabeDb, listing: Listing): UpsertResult {
  const now = Date.now();
  const fingerprint = listing.id; // slice: source-id only; cross-source dedupe later
  const existing = db._raw
    .prepare<[string], { id: string; payload: string }>('SELECT id, payload FROM listings WHERE id = ?')
    .get(listing.id);
  const payload = JSON.stringify(listing);
  if (!existing) {
    db._raw
      .prepare(
        'INSERT INTO listings (id,source,url,fingerprint,payload,first_seen_at,last_seen_at,status) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(listing.id, listing.source, listing.url, fingerprint, payload, now, now, 'new');
    return { changed: true, isNew: true, fingerprint };
  }
  if (existing.payload === payload) {
    db._raw.prepare('UPDATE listings SET last_seen_at = ? WHERE id = ?').run(now, listing.id);
    return { changed: false, isNew: false, fingerprint };
  }
  db._raw
    .prepare('UPDATE listings SET payload = ?, last_seen_at = ? WHERE id = ?')
    .run(payload, now, listing.id);
  return { changed: true, isNew: false, fingerprint };
}
