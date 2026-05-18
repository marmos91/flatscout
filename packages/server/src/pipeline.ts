import type { Logger } from 'pino';
import { Listing, evaluateFilters, scoreListing } from '@wabe/core';
import type { WabeDb } from '@wabe/db';
import type { LoadedConfig } from './config.js';
import type { LoadedPlugin } from './loader.js';
import type { CircuitBreaker } from './circuit.js';
import type { Quota } from './quota.js';
import { upsertListing } from './dedupe.js';

export interface RunOptions {
  cfg: LoadedConfig;
  db: WabeDb;
  logger: Logger;
  signal: AbortSignal;
  sources: LoadedPlugin<'source'>[];
  notifiers: LoadedPlugin<'notifier'>[];
  breakers: Map<string, CircuitBreaker>;
  quota: Quota;
}

/**
 * Runs every enabled source through the pipeline once, concurrently.
 *
 * Sources are isolated from each other — a thrown exception in one source's
 * `runSource()` is caught there, recorded as a failure, and does NOT abort the
 * sibling sources. Awaits all sources before returning.
 */
export async function runOnce(opts: RunOptions): Promise<void> {
  await Promise.all(opts.sources.map((s) => runSource(s, opts)));
}

/**
 * Drives a single source end-to-end: fetch → upsert → filter → score → notify.
 *
 * If the source has an open circuit breaker we skip it. Otherwise we iterate
 * the source's async generator; each emitted RawListing is normalised through
 * `Listing.parse`, upserted (unchanged rows are skipped), filtered, scored,
 * and persisted. Listings at or above `notify.threshold` consume one quota
 * slot and are then dispatched to every notifier via `notifySafely`. A thrown
 * error anywhere in the source path records a failure row, ticks the circuit
 * breaker, and returns — sibling sources are unaffected.
 */
async function runSource(src: LoadedPlugin<'source'>, opts: RunOptions): Promise<void> {
  const log = opts.logger.child({ source: src.name, plugin: src.plugin.name });
  const breaker = opts.breakers.get(src.name);
  if (breaker && !breaker.allow()) {
    log.warn({ state: breaker.state() }, 'circuit open; skipping source');
    return;
  }
  const ctx = {
    logger: log,
    config: src.config,
    signal: opts.signal,
    db: opts.db,
  };
  try {
    for await (const raw of src.plugin.fetch(ctx)) {
      if (opts.signal.aborted) return;
      const enriched: Listing = Listing.parse({
        ...raw,
        id: raw.id ?? `${raw.source}:unknown:${Date.now()}`,
        first_seen_at: raw.first_seen_at ?? new Date(),
        last_seen_at: raw.last_seen_at ?? new Date(),
      });
      const { changed, isNew } = upsertListing(opts.db, enriched);
      if (!changed) continue;
      const filterResult = await evaluateFilters(opts.cfg.filters.filters, enriched);
      if (!filterResult.passed) {
        log.debug({ listing_id: enriched.id, reason: filterResult.reason }, 'filtered out');
        continue;
      }
      const score = await scoreListing(opts.cfg.scoring.scoring, enriched);
      opts.db._raw
        .prepare('INSERT INTO scores (listing_id, scored_at, final, breakdown) VALUES (?,?,?,?)')
        .run(enriched.id, Date.now(), score.final, JSON.stringify(score.breakdown));
      if (score.final < opts.cfg.scoring.notify.threshold) {
        log.debug({ listing_id: enriched.id, score: score.final }, 'below threshold');
        continue;
      }
      if (!opts.quota.tryConsume()) {
        log.info({ listing_id: enriched.id, score: score.final }, 'quota exhausted; skipping notify');
        continue;
      }
      const event = { listing: enriched, score };
      for (const n of opts.notifiers) await notifySafely(n, event, opts);
      log.info({ listing_id: enriched.id, score: score.final, isNew }, 'notified');
    }
    breaker?.recordSuccess();
  } catch (err) {
    log.error({ err }, 'source pipeline failed');
    breaker?.recordFailure();
    opts.db._raw
      .prepare('INSERT INTO failures (plugin, occurred_at, message, stack) VALUES (?,?,?,?)')
      .run(src.name, Date.now(), (err as Error).message, (err as Error).stack ?? null);
  }
}

/**
 * Dispatches one notifier with full error isolation.
 *
 * Wraps the notifier call so a throwing notifier is logged and recorded into
 * the `failures` table without aborting the surrounding loop — a misbehaving
 * Telegram bot, say, must not block an email notifier on the same event.
 * Successful deliveries are recorded in the `notifications` table.
 */
async function notifySafely(
  n: LoadedPlugin<'notifier'>,
  event: { listing: Listing; score: { final: number; breakdown: Record<string, number> } },
  opts: RunOptions,
): Promise<void> {
  const log = opts.logger.child({ notifier: n.name });
  try {
    const ctx = { logger: log, config: n.config, signal: opts.signal, db: opts.db };
    const res = await n.plugin.notify(event, ctx);
    opts.db._raw
      .prepare('INSERT INTO notifications (listing_id, notifier, sent_at, payload) VALUES (?,?,?,?)')
      .run(event.listing.id, n.name, Date.now(), JSON.stringify({ ok: res.ok, message_id: res.message_id }));
  } catch (err) {
    log.error({ err }, 'notifier failed');
    opts.db._raw
      .prepare('INSERT INTO failures (plugin, listing_id, occurred_at, message, stack) VALUES (?,?,?,?,?)')
      .run(n.name, event.listing.id, Date.now(), (err as Error).message, (err as Error).stack ?? null);
  }
}
