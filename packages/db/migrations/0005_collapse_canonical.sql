-- Cross-source row collapse: one row per canonical_key.
-- The TS runner in @wabe/db/src/collapse-listings.ts is invoked by migrate.ts
-- inside the same transaction window after this SQL applies. It folds rows from
-- listings_old into the new listings table via resolveFields().

-- Snapshot pre-collapse rows so a rollback works without re-fetching.
CREATE TABLE listings_legacy AS SELECT * FROM listings;

-- Rename current listings out of the way. The TS runner reads from it.
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
  canonical_key   TEXT NOT NULL,
  source_priority INTEGER NOT NULL DEFAULT 50,
  seen_on_sources TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX idx_listings_canonical_key ON listings (canonical_key);
CREATE INDEX idx_listings_source ON listings (source);
CREATE INDEX idx_listings_first_seen ON listings (first_seen_at);

-- listings_fts is repopulated by the TS runner; clear it here.
DELETE FROM listings_fts;
