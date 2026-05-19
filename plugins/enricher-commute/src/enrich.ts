import type { Logger } from 'pino';
import type Database from 'better-sqlite3';
import type { CommuteMode } from '@wabe/core';
import { Listing as ListingSchema } from '@wabe/core';
import type { Listing } from '@wabe/core';
import pLimit from 'p-limit';
import type { CommuteConfig } from './schemas.js';
import { CommuteCache, normalizeAddress, type Coord, type Weekday } from './cache.js';
import { geocode } from './geocode.js';
import { routeOrs } from './route-ors.js';
import { routeMotis } from './route-motis.js';
import { hhmmToMin, nextWeekdayAt } from './time.js';

type TargetCoords = Map<string, Coord>; // target id → [lat, lng]

async function resolveTargetCoords(
  cfg: CommuteConfig,
  cache: CommuteCache,
  logger: Logger,
  signal: AbortSignal,
): Promise<TargetCoords> {
  const out: TargetCoords = new Map();
  for (const [id, t] of Object.entries(cfg.targets)) {
    if (t.coords) {
      // user-supplied coords in schema are [lng, lat] (consistent with Listing.location.coords)
      // store internally as [lat, lng]
      out.set(id, [t.coords[1], t.coords[0]]);
      continue;
    }
    const norm = normalizeAddress(t.address!);
    const cached = cache.getGeocode(norm);
    if (cached) {
      out.set(id, [cached.lat, cached.lng]);
      continue;
    }
    const r = await geocode(t.address!, {
      peliasUrl: cfg.endpoints.pelias_url,
      timeoutMs: cfg.timeouts.geocode_ms,
      logger,
      signal,
    });
    if (!r) {
      logger.warn({ target: id }, 'target geocode failed; skipping target this run');
      continue;
    }
    cache.upsertGeocode(norm, r, new Date());
    out.set(id, [r.lat, r.lng]);
  }
  return out;
}

async function resolveListingCoords(
  listing: Listing,
  cfg: CommuteConfig,
  cache: CommuteCache,
  logger: Logger,
  signal: AbortSignal,
): Promise<Coord | null> {
  if (listing.location.coords) {
    // Listing.location.coords is [lng, lat]; flip to [lat, lng] for internal use
    return [listing.location.coords[1], listing.location.coords[0]];
  }
  const addr = [listing.location.address, listing.location.postal_code, listing.location.city]
    .filter(Boolean)
    .join(', ');
  if (!addr) return null;
  const norm = normalizeAddress(addr);
  const cached = cache.getGeocode(norm);
  if (cached) return [cached.lat, cached.lng];
  const r = await geocode(addr, {
    peliasUrl: cfg.endpoints.pelias_url,
    timeoutMs: cfg.timeouts.geocode_ms,
    logger,
    signal,
  });
  if (!r) return null;
  cache.upsertGeocode(norm, r, new Date());
  return [r.lat, r.lng];
}

async function computeOne(
  from: Coord,
  to: Coord,
  targetId: string,
  mode: CommuteMode,
  weekday: Weekday,
  arriveByHHMM: string,
  cfg: CommuteConfig,
  cache: CommuteCache,
  logger: Logger,
  signal: AbortSignal,
): Promise<{ durationS: number; distanceM: number } | null> {
  const arriveByMin = hhmmToMin(arriveByHHMM);
  const key = { from, target: targetId, mode, weekday, arriveByMin };
  if (cfg.cache.enabled) {
    const hit = cache.getCommute(key);
    if (hit) return { durationS: hit.durationS, distanceM: hit.distanceM };
  }
  let r: { durationS: number; distanceM: number } | null;
  if (mode === 'transit') {
    const at = nextWeekdayAt(weekday, arriveByHHMM);
    r = await routeMotis({ from, to }, at, {
      motisUrl: cfg.endpoints.motis_url,
      timeoutMs: cfg.timeouts.route_ms,
      logger,
      signal,
    });
  } else {
    r = await routeOrs({ from, to }, mode, {
      orsUrl: cfg.endpoints.ors_url,
      timeoutMs: cfg.timeouts.route_ms,
      logger,
      signal,
    });
  }
  if (!r) return null;
  if (cfg.cache.enabled) cache.upsertCommute(key, { ...r, computedAt: new Date() });
  return r;
}

export async function enrichCommute(
  listing: Listing,
  cfg: CommuteConfig,
  db: Database.Database,
  logger: Logger,
  signal: AbortSignal,
): Promise<Listing> {
  const cache = new CommuteCache(db, cfg.cache.quantize_decimals);
  const targetCoords = await resolveTargetCoords(cfg, cache, logger, signal);
  const listingCoords = await resolveListingCoords(listing, cfg, cache, logger, signal);
  if (!listingCoords) {
    logger.warn({ listing_id: listing.id }, 'listing coords unresolved; skipping commute enrich');
    return listing;
  }

  const limit = pLimit(4);
  const result: Record<string, Record<string, { duration_min: number; distance_km: number; computed_at: Date }>> = {};

  const jobs: Promise<void>[] = [];
  for (const [tid, t] of Object.entries(cfg.targets)) {
    const to = targetCoords.get(tid);
    if (!to) continue;
    for (const mode of t.modes) {
      jobs.push(
        limit(async () => {
          const r = await computeOne(listingCoords, to, tid, mode, t.weekday, t.arrive_by, cfg, cache, logger, signal);
          if (!r) return;
          if (!result[tid]) result[tid] = {};
          const tidResult = result[tid];
          if (tidResult) {
            tidResult[mode] = {
              duration_min: Math.round(r.durationS / 60),
              distance_km: r.distanceM / 1000,
              computed_at: new Date(),
            };
          }
        }),
      );
    }
  }
  await Promise.all(jobs);

  if (Object.keys(result).length === 0) return listing;

  return ListingSchema.parse({
    ...listing,
    enriched: { ...listing.enriched, commute: result },
  });
}
