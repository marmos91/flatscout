import { sql } from 'drizzle-orm';
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Persisted listings, keyed by `${source}:${external_id}`. `payload` stores the full canonical Listing JSON. */
export const listings = sqliteTable('listings', {
  id: text('id').primaryKey(),
  source: text('source').notNull(),
  url: text('url').notNull(),
  fingerprint: text('fingerprint').notNull(),
  payload: text('payload', { mode: 'json' }).notNull(),
  first_seen_at: integer('first_seen_at').notNull(),
  last_seen_at: integer('last_seen_at').notNull(),
  status: text('status').notNull().default('new'),
  blocked_reason: text('blocked_reason'),
});

/** Append-only score history; one row per (listing, scored_at) pair. */
export const scores = sqliteTable(
  'scores',
  {
    listing_id: text('listing_id')
      .notNull()
      .references(() => listings.id),
    scored_at: integer('scored_at').notNull(),
    final: integer('final').notNull(),
    breakdown: text('breakdown', { mode: 'json' }).notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.listing_id, t.scored_at] }) }),
);

/** Notifier dispatch log — one row per successful delivery. */
export const notifications = sqliteTable('notifications', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  listing_id: text('listing_id')
    .notNull()
    .references(() => listings.id),
  notifier: text('notifier').notNull(),
  sent_at: integer('sent_at').notNull(),
  payload: text('payload', { mode: 'json' }),
});

/** Daily notification counter, keyed by UTC `YYYY-MM-DD`. Drives the daily quota. */
export const quota_log = sqliteTable('quota_log', {
  day: text('day').primaryKey(),
  sent_count: integer('sent_count').notNull().default(0),
});

/** Persistent log of plugin failures (source fetch errors, notifier dispatch errors). */
export const failures = sqliteTable('failures', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  plugin: text('plugin').notNull(),
  listing_id: text('listing_id'),
  occurred_at: integer('occurred_at').notNull(),
  message: text('message').notNull(),
  stack: text('stack'),
});

/** Per-source resumption cursor (e.g. last sitemap timestamp scanned). */
export const sitemap_state = sqliteTable('sitemap_state', {
  source: text('source').primaryKey(),
  last_seen_at: integer('last_seen_at').notNull(),
  state: text('state', { mode: 'json' }).notNull(),
});

/** Raw SQL DDL for the FTS5 virtual table that backs full-text search over listing descriptions. */
export const _ftsInit = sql`
CREATE VIRTUAL TABLE IF NOT EXISTS listings_fts USING fts5(
  id UNINDEXED,
  description,
  tokenize='unicode61'
);
`;
