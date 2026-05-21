import { request } from 'undici';
import type { Logger } from 'pino';

export interface GeocodeDeps {
  peliasUrl: string;
  /** Optional fallback. Hit only when Pelias returns null. Null disables fallback. */
  nominatimUrl: string | null;
  timeoutMs: number;
  logger: Logger;
  signal: AbortSignal;
}

export interface GeoResult {
  lat: number;
  lng: number;
}

/** Nominatim public ToS: max 1 req/sec, identifying User-Agent. We self-throttle. */
const NOMINATIM_MIN_INTERVAL_MS = 1100;
let lastNominatimAt = 0;

/**
 * Geocode an address. Tries Pelias first; on null (unreachable, no match,
 * 4xx/5xx, throw), falls back to Nominatim if configured. Returns null only
 * when both fail or the fallback is disabled.
 */
export async function geocode(address: string, deps: GeocodeDeps): Promise<GeoResult | null> {
  const fromPelias = await geocodePelias(address, deps);
  if (fromPelias) return fromPelias;
  if (!deps.nominatimUrl) return null;
  return geocodeNominatim(address, deps);
}

async function geocodePelias(address: string, deps: GeocodeDeps): Promise<GeoResult | null> {
  const url = `${deps.peliasUrl.replace(/\/$/, '')}/v1/search?text=${encodeURIComponent(address)}&size=1`;
  try {
    const res = await request(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: deps.signal,
      bodyTimeout: deps.timeoutMs,
      headersTimeout: deps.timeoutMs,
    });
    if (res.statusCode >= 500) {
      deps.logger.warn({ status: res.statusCode, address }, 'pelias 5xx');
      return null;
    }
    if (res.statusCode >= 400) {
      deps.logger.warn({ status: res.statusCode, address }, 'pelias 4xx');
      return null;
    }
    const body = (await res.body.json()) as {
      features?: { geometry?: { coordinates?: [number, number] } }[];
    };
    const feat = body.features?.[0];
    const coords = feat?.geometry?.coordinates;
    if (!coords || coords.length < 2) return null;
    const [lng, lat] = coords;
    return { lng, lat };
  } catch (err) {
    deps.logger.warn({ err, address }, 'pelias request failed');
    return null;
  }
}

async function geocodeNominatim(address: string, deps: GeocodeDeps): Promise<GeoResult | null> {
  // Self-throttle to Nominatim's 1 req/sec ToS limit.
  const now = Date.now();
  const wait = Math.max(0, lastNominatimAt + NOMINATIM_MIN_INTERVAL_MS - now);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastNominatimAt = Date.now();

  // Bias to CH to avoid global mis-matches (e.g. "Bahnhofstrasse 1" hits dozens of countries).
  const url = `${(deps.nominatimUrl as string).replace(/\/$/, '')}/search?format=json&limit=1&countrycodes=ch&q=${encodeURIComponent(
    address,
  )}`;
  try {
    const res = await request(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        // Nominatim ToS requires a descriptive User-Agent. flatscout identifies itself.
        'user-agent': 'flatscout-enricher-commute/0 (https://github.com/marmos91/flatscout)',
      },
      signal: deps.signal,
      bodyTimeout: deps.timeoutMs,
      headersTimeout: deps.timeoutMs,
    });
    if (res.statusCode >= 400) {
      deps.logger.warn({ status: res.statusCode, address }, 'nominatim non-2xx');
      return null;
    }
    const body = (await res.body.json()) as { lat?: string; lon?: string }[];
    const r = body[0];
    if (!r?.lat || !r?.lon) return null;
    const lat = Number.parseFloat(r.lat);
    const lng = Number.parseFloat(r.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
  } catch (err) {
    deps.logger.warn({ err, address }, 'nominatim request failed');
    return null;
  }
}
