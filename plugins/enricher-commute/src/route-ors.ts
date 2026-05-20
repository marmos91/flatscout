import { request } from 'undici';
import type { Logger } from 'pino';
import type { CommuteMode } from '@wabe/core';

export interface OrsDeps {
  orsUrl: string;
  timeoutMs: number;
  logger: Logger;
  signal: AbortSignal;
}

export interface RouteResult {
  durationS: number;
  distanceM: number;
}

const PROFILE_MAP: Partial<Record<CommuteMode, string>> = {
  driving: 'driving-car',
  cycling: 'cycling-regular',
  walking: 'foot-walking',
};

export async function routeOrs(
  pts: { from: [number, number]; to: [number, number] }, // [lat, lng]
  mode: CommuteMode,
  deps: OrsDeps,
): Promise<RouteResult | null> {
  const profile = PROFILE_MAP[mode];
  if (!profile) return null;
  const url = `${deps.orsUrl.replace(/\/$/, '')}/v2/directions/${profile}`;
  // ORS coordinates are [lng, lat] order.
  const body = JSON.stringify({
    coordinates: [
      [pts.from[1], pts.from[0]],
      [pts.to[1], pts.to[0]],
    ],
  });
  try {
    const res = await request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body,
      signal: deps.signal,
      bodyTimeout: deps.timeoutMs,
      headersTimeout: deps.timeoutMs,
    });
    if (res.statusCode >= 500) {
      deps.logger.warn({ status: res.statusCode, mode }, 'ors 5xx');
      return null;
    }
    if (res.statusCode === 404) {
      // 404 = no routable path between the two points (island, gated estate,
      // off-network address). Expected for a meaningful fraction of legit
      // listings; surfacing once per probe at debug avoids drowning the daemon
      // log in warnings that aren't actionable. Discard the body so undici
      // releases the connection.
      await res.body.dump();
      deps.logger.debug({ status: 404, mode }, 'ors: no route between points');
      return null;
    }
    if (res.statusCode >= 400) {
      deps.logger.warn({ status: res.statusCode, mode }, 'ors 4xx');
      return null;
    }
    const j = (await res.body.json()) as { routes?: { summary: { distance: number; duration: number } }[] };
    const r = j.routes?.[0];
    if (!r) return null;
    return { durationS: Math.round(r.summary.duration), distanceM: Math.round(r.summary.distance) };
  } catch (err) {
    deps.logger.warn({ err, mode }, 'ors request failed');
    return null;
  }
}
