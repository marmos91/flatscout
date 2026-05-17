CREATE TABLE listings (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  url TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  payload TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  blocked_reason TEXT
);
CREATE INDEX idx_listings_source ON listings (source);
CREATE INDEX idx_listings_fingerprint ON listings (fingerprint);
CREATE INDEX idx_listings_first_seen ON listings (first_seen_at);

CREATE TABLE scores (
  listing_id TEXT NOT NULL REFERENCES listings(id),
  scored_at INTEGER NOT NULL,
  final INTEGER NOT NULL,
  breakdown TEXT NOT NULL,
  PRIMARY KEY (listing_id, scored_at)
);
CREATE INDEX idx_scores_final ON scores (final);

CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id TEXT NOT NULL REFERENCES listings(id),
  notifier TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  payload TEXT
);

CREATE TABLE quota_log (
  day TEXT PRIMARY KEY,
  sent_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin TEXT NOT NULL,
  listing_id TEXT,
  occurred_at INTEGER NOT NULL,
  message TEXT NOT NULL,
  stack TEXT
);

CREATE TABLE sitemap_state (
  source TEXT PRIMARY KEY,
  last_seen_at INTEGER NOT NULL,
  state TEXT NOT NULL
);

CREATE VIRTUAL TABLE listings_fts USING fts5(
  id UNINDEXED,
  description,
  tokenize='unicode61'
);

-- NOTE: deviated from plan — `IF NOT EXISTS` added because migrate.ts
-- pre-creates this tracking table; the plan's bare CREATE collided with it.
CREATE TABLE IF NOT EXISTS _migrations (
  filename TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
