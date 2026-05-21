import { request } from 'undici';
import { sleep } from '@flatscout/utils';
import type { PortalImpl, PortalListing } from './types.js';

const ENDPOINT = 'https://flatfox.ch/api/v1/public-listing/';
const PAGE_SIZE = 100;
const PACE_MS = 750;

interface FlatfoxAgency {
  name?: string | null;
  website?: string | null;
}

interface FlatfoxResult {
  pk: number;
  slug?: string | null;
  description?: string | null;
  url?: string | null;
  agency?: FlatfoxAgency | null;
}

interface FlatfoxPage {
  results: FlatfoxResult[];
  next: string | null;
}

function listingUrl(r: FlatfoxResult): string {
  if (r.url) return `https://flatfox.ch${r.url}`;
  return `https://flatfox.ch/en/flat/${r.slug ?? r.pk}/`;
}

export const flatfoxPortal: PortalImpl = {
  name: 'flatfox',
  async fetchTop(top: number, signal: AbortSignal, log: (m: string) => void): Promise<PortalListing[]> {
    const out: PortalListing[] = [];
    let offset = 0;
    while (out.length < top) {
      if (signal.aborted) break;
      const url = `${ENDPOINT}?status=act&limit=${PAGE_SIZE}&offset=${offset}`;
      const res = await request(url, {
        method: 'GET',
        signal,
        headers: { accept: 'application/json' },
      });
      if (res.statusCode < 200 || res.statusCode >= 300) {
        const body = await res.body.text();
        throw new Error(`flatfox ${res.statusCode}: ${body.slice(0, 200)}`);
      }
      const page = (await res.body.json()) as FlatfoxPage;
      if (!page.results.length) break;
      for (const r of page.results) {
        out.push({
          url: listingUrl(r),
          description: r.description ?? null,
          agency_website: r.agency?.website ?? null,
          agency_name: r.agency?.name ?? null,
        });
        if (out.length >= top) break;
      }
      log(`fetched offset=${offset} (${out.length}/${top})`);
      if (page.next === null) break;
      offset += PAGE_SIZE;
      await sleep(PACE_MS, signal).catch(() => undefined);
    }
    return out;
  },
};
