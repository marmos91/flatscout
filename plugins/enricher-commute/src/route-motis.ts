import { request } from 'undici';
import type { Logger } from 'pino';
import type { RouteResult } from './route-ors.js';

export interface MotisDeps {
  motisUrl: string;
  timeoutMs: number;
  logger: Logger;
  signal: AbortSignal;
}

export async function routeMotis(
  pts: { from: [number, number]; to: [number, number] }, // [lat, lng]
  arriveBy: Date,
  deps: MotisDeps,
): Promise<RouteResult | null> {
  const url = `${deps.motisUrl.replace(/\/$/, '')}/api/v1/plan`;
  const body = JSON.stringify({
    start: { lat: pts.from[0], lng: pts.from[1] },
    destination: { lat: pts.to[0], lng: pts.to[1] },
    interval: {
      begin: Math.floor(arriveBy.getTime() / 1000) - 3600,
      end: Math.floor(arriveBy.getTime() / 1000),
    },
    arriveBy: true,
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
      deps.logger.warn({ status: res.statusCode }, 'motis 5xx');
      return null;
    }
    if (res.statusCode >= 400) {
      deps.logger.warn({ status: res.statusCode }, 'motis 4xx');
      return null;
    }
    // Motis 2.x: { itineraries: [ { duration, transfers, ... } ] }
    // Motis 1.x: { content: { connections: [ { duration, ... } ] } }
    const j = (await res.body.json()) as {
      itineraries?: { duration: number }[];
      content?: { connections?: { duration: number }[] };
    };
    const conns = j.itineraries ?? j.content?.connections ?? [];
    if (conns.length === 0) return null;
    let fastest = conns[0]!;
    for (let i = 1; i < conns.length; i++) {
      const c = conns[i]!;
      if (c.duration < fastest.duration) fastest = c;
    }
    return { durationS: fastest.duration, distanceM: 0 }; // Motis itinerary distance not directly exposed
  } catch (err) {
    deps.logger.warn({ err }, 'motis request failed');
    return null;
  }
}
