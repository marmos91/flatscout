import {
  Listing,
  type RawListing,
  resolveFields,
  SOURCE_PRIORITY_DEFAULTS,
  DEFAULT_SOURCE_PRIORITY,
} from '@wabe/core';
import type { WabeDb } from './client.js';

interface LegacyRow {
  id: string;
  source: string;
  url: string;
  payload: string;
  canonical_key: string;
  source_priority: number;
  first_seen_at: number;
  last_seen_at: number;
}

type RawDb = WabeDb['_raw'];

/**
 * Fold rows from `listings_old` into the new `listings` table via resolveFields().
 *
 * Rebuilds dependent-table rows (scores/notifications/failures stored in
 * <table>_old by 0005) by mapping each legacy listing.id → its canonical_key
 * (the surviving row's id). Re-populates listings_fts from the surviving rows.
 *
 * Idempotent: if `listings_old` doesn't exist, the runner exits silently. Safe
 * to re-invoke after a crash because the entire body is wrapped in a single
 * transaction.
 */
export function collapseListings(db: WabeDb): void {
  const raw = db._raw;
  if (!tableExistsByName(raw, 'listings_old')) return;

  raw.transaction(() => {
    const rows = raw
      .prepare<[], LegacyRow>(
        'SELECT id, source, url, payload, canonical_key, source_priority, first_seen_at, last_seen_at FROM listings_old ORDER BY canonical_key, first_seen_at ASC',
      )
      .all();

    // Group by canonical_key; older first_seen_at first within a group.
    const groups = new Map<string, LegacyRow[]>();
    for (const r of rows) {
      const list = groups.get(r.canonical_key) ?? [];
      list.push(r);
      groups.set(r.canonical_key, list);
    }

    // Map legacy id → canonical_key for FK rebuild.
    const idMap = new Map<string, string>();

    for (const [ck, group] of groups) {
      let merged: Listing | null = null;
      for (const row of group) {
        const r = listingPayloadToRaw(JSON.parse(row.payload));
        if (!merged) {
          merged = materialise(r, ck, row.source_priority);
        } else {
          const incomingPriority =
            row.source_priority ?? SOURCE_PRIORITY_DEFAULTS[r.source] ?? DEFAULT_SOURCE_PRIORITY;
          const out = resolveFields(merged, r, incomingPriority);
          merged = out.next;
        }
        idMap.set(row.id, ck);
      }
      if (!merged) continue;

      // Upsert into new listings table — idempotent on re-run.
      const existing = raw.prepare('SELECT id FROM listings WHERE id = ?').get(ck);
      if (existing) {
        raw
          .prepare(
            'UPDATE listings SET source=?, url=?, payload=?, last_seen_at=?, source_priority=?, seen_on_sources=? WHERE id=?',
          )
          .run(
            merged.source,
            merged.url,
            JSON.stringify(merged),
            merged.last_seen_at.getTime(),
            merged.source_priority,
            JSON.stringify(merged.seen_on_sources),
            ck,
          );
      } else {
        raw
          .prepare(
            'INSERT INTO listings (id,source,url,fingerprint,payload,first_seen_at,last_seen_at,status,canonical_key,source_priority,seen_on_sources) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
          )
          .run(
            ck,
            merged.source,
            merged.url,
            ck,
            JSON.stringify(merged),
            merged.first_seen_at.getTime(),
            merged.last_seen_at.getTime(),
            'new',
            ck,
            merged.source_priority,
            JSON.stringify(merged.seen_on_sources),
          );
      }

      raw.prepare('DELETE FROM listings_fts WHERE id = ?').run(ck);
      raw
        .prepare('INSERT INTO listings_fts (id, description) VALUES (?, ?)')
        .run(ck, merged.description ?? '');
    }

    // Repoint <table>_old rows into the new dependent tables. Rows whose
    // listing_id never appeared in listings_old (orphans) are dropped silently.
    repointDependents(raw, idMap);

    // Drop the staging tables. They've been folded into the new shape.
    raw.exec('DROP TABLE listings_old');
    if (tableExistsByName(raw, 'scores_old')) raw.exec('DROP TABLE scores_old');
    if (tableExistsByName(raw, 'notifications_old')) raw.exec('DROP TABLE notifications_old');
    if (tableExistsByName(raw, 'failures_old')) raw.exec('DROP TABLE failures_old');
  })();
}

function tableExistsByName(raw: RawDb, name: string): boolean {
  return Boolean(raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function repointDependents(raw: RawDb, idMap: Map<string, string>): void {
  if (tableExistsByName(raw, 'scores_old')) {
    const rows = raw
      .prepare<[], { listing_id: string; scored_at: number; final: number; breakdown: string }>(
        'SELECT listing_id, scored_at, final, breakdown FROM scores_old',
      )
      .all();
    const ins = raw.prepare(
      'INSERT OR IGNORE INTO scores (listing_id, scored_at, final, breakdown) VALUES (?,?,?,?)',
    );
    for (const r of rows) {
      const newId = idMap.get(r.listing_id);
      if (!newId) continue;
      ins.run(newId, r.scored_at, r.final, r.breakdown);
    }
  }
  if (tableExistsByName(raw, 'notifications_old')) {
    const rows = raw
      .prepare<[], { listing_id: string; notifier: string; sent_at: number; payload: string | null }>(
        'SELECT listing_id, notifier, sent_at, payload FROM notifications_old',
      )
      .all();
    const ins = raw.prepare(
      'INSERT INTO notifications (listing_id, notifier, sent_at, payload) VALUES (?,?,?,?)',
    );
    for (const r of rows) {
      const newId = idMap.get(r.listing_id);
      if (!newId) continue;
      ins.run(newId, r.notifier, r.sent_at, r.payload);
    }
  }
  if (tableExistsByName(raw, 'failures_old')) {
    const rows = raw
      .prepare<
        [],
        {
          plugin: string;
          listing_id: string | null;
          occurred_at: number;
          message: string;
          stack: string | null;
        }
      >('SELECT plugin, listing_id, occurred_at, message, stack FROM failures_old')
      .all();
    const ins = raw.prepare(
      'INSERT INTO failures (plugin, listing_id, occurred_at, message, stack) VALUES (?,?,?,?,?)',
    );
    for (const r of rows) {
      const repointed = r.listing_id ? (idMap.get(r.listing_id) ?? null) : null;
      ins.run(r.plugin, repointed, r.occurred_at, r.message, r.stack);
    }
  }
}

function listingPayloadToRaw(p: unknown): RawListing {
  const parsed = Listing.parse(p);
  return {
    id: parsed.id,
    source: parsed.source,
    url: parsed.url,
    first_seen_at: parsed.first_seen_at,
    last_seen_at: parsed.last_seen_at,
    price: parsed.price,
    rooms: parsed.rooms,
    area_m2: parsed.area_m2,
    floor: parsed.floor,
    total_floors: parsed.total_floors,
    built_year: parsed.built_year,
    renovated_year: parsed.renovated_year,
    location: parsed.location,
    features: parsed.features,
    description: parsed.description,
    photos: parsed.photos,
    available_from: parsed.available_from,
    lease_until: parsed.lease_until,
    rental_term: parsed.rental_term,
    agency: parsed.agency,
    contact: parsed.contact,
    enriched: {
      ...parsed.enriched,
      external_ids: {
        ...(((parsed.enriched as Record<string, unknown>).external_ids as
          | Record<string, string>
          | undefined) ?? {}),
        [parsed.source]: parsed.id,
      },
    },
    extra: parsed.extra,
  };
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
  });
}
