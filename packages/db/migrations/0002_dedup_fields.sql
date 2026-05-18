-- Phase A: cross-source dedup support.
-- canonical_key collapses near-equal listings across sources;
-- source_priority resolves ties at notify time;
-- seen_on_sources is materialised by canonical-dedup on each new arrival.

ALTER TABLE listings ADD COLUMN canonical_key TEXT NOT NULL DEFAULT '';
ALTER TABLE listings ADD COLUMN source_priority INTEGER NOT NULL DEFAULT 50;
-- JSON array of source plugin names that have reported this canonical group.
ALTER TABLE listings ADD COLUMN seen_on_sources TEXT NOT NULL DEFAULT '[]';

CREATE INDEX idx_listings_canonical_key ON listings (canonical_key);
