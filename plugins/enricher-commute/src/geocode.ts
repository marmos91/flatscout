import { request } from 'undici';
import type { Logger } from 'pino';

export interface GeocodeDeps {
  peliasUrl: string;
  timeoutMs: number;
  logger: Logger;
  signal: AbortSignal;
}

export interface GeoResult {
  lat: number;
  lng: number;
}

export async function geocode(address: string, deps: GeocodeDeps): Promise<GeoResult | null> {
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
