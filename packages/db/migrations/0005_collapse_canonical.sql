-- Cross-source row collapse: one row per canonical_key.
-- The TS runner in @wabe/db/src/collapse-listings.ts is invoked by migrate.ts
-- inside the same transaction window after this SQL applies. It folds rows from
-- listings_old into the new listings table via resolveFields().

-- Snapshot pre-collapse rows so a rollback works without re-fetching.
CREATE TABLE listings_legacy AS SELECT * FROM listings;

-- Rename current listings out of the way. The TS runner reads from it.
-- SQLite keeps indexes attached to the renamed table under their original names,
-- which would collide with the recreates below; drop them first.
DROP INDEX IF EXISTS idx_listings_source;
DROP INDEX IF EXISTS idx_listings_fingerprint;
DROP INDEX IF EXISTS idx_listings_first_seen;
DROP INDEX IF EXISTS idx_listings_canonical_key;
ALTER TABLE listings RENAME TO listings_old;

-- Recreate listings with canonical_key as PK. Column shape unchanged; id == canonical_key.
CREATE TABLE listings (
  id              TEXT PRIMARY KEY,
  source          TEXT NOT NULL,
  url             TEXT NOT NULL,
  fingerprint     TEXT NOT NULL,
  payload         TEXT NOT NULL,
  first_seen_at   INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'new',
  blocked_reason  TEXT,
  canonical_key   TEXT NOT NULL DEFAULT '',
  source_priority INTEGER NOT NULL DEFAULT 50,
  seen_on_sources TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX idx_listings_canonical_key ON listings (canonical_key);
CREATE INDEX idx_listings_source ON listings (source);
CREATE INDEX idx_listings_first_seen ON listings (first_seen_at);

-- listings_fts is repopulated by the TS runner; clear it here.
DELETE FROM listings_fts;

-- SQLite's ALTER TABLE ... RENAME TO automatically rewrites foreign-key
-- references in other tables to follow the renamed table — so scores,
-- notifications, and failures now point at `listings_old(id)`. Swap each one
-- back to `listings(id)` by saving its rows in a `<table>_old` snapshot and
-- recreating with the FK pointing at the new listings. The TS collapse runner
-- repoints listing_id values from legacy per-source ids to the new canonical
-- surviving rows. For a fresh DB these snapshots are simply empty.

DROP INDEX IF EXISTS idx_scores_final;
ALTER TABLE scores RENAME TO scores_old;
CREATE TABLE scores (
  listing_id TEXT NOT NULL REFERENCES listings(id),
  scored_at INTEGER NOT NULL,
  final INTEGER NOT NULL,
  breakdown TEXT NOT NULL,
  PRIMARY KEY (listing_id, scored_at)
);
CREATE INDEX idx_scores_final ON scores (final);

ALTER TABLE notifications RENAME TO notifications_old;
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id TEXT NOT NULL REFERENCES listings(id),
  notifier TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  payload TEXT
);

ALTER TABLE failures RENAME TO failures_old;
CREATE TABLE failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin TEXT NOT NULL,
  listing_id TEXT,
  occurred_at INTEGER NOT NULL,
  message TEXT NOT NULL,
  stack TEXT
);
