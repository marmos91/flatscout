import { request } from 'undici';
import { gunzipSync } from 'node:zlib';
import { XMLParser } from 'fast-xml-parser';

export interface SitemapEntry {
  loc: string;
  lastmod: string | null;
  image_loc: string | null;
  geo_location: string | null;
}

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

/** Fetch + gunzip + parse a single sitemap leaf (e.g. pdp-1-sitemap-RENT-de.xml.gz). */
export async function fetchSitemapLeaf(url: string, signal: AbortSignal): Promise<SitemapEntry[]> {
  const res = await request(url, { signal, method: 'GET' });
  if (res.statusCode !== 200) throw new Error(`sitemap leaf ${url} responded ${res.statusCode}`);
  const buf = Buffer.from(await res.body.arrayBuffer());
  const xmlText = url.endsWith('.gz') ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');
  return parseUrlset(xmlText);
}

export function parseUrlset(xmlText: string): SitemapEntry[] {
  const parsed = xml.parse(xmlText) as { urlset?: { url?: unknown } };
  const urls = parsed.urlset?.url;
  const list = Array.isArray(urls) ? urls : urls ? [urls] : [];
  return list.map((u) => {
    const node = u as {
      loc?: string;
      lastmod?: string;
      'image:image'?: { 'image:loc'?: string; 'image:geo_location'?: string };
    };
    const img = node['image:image'];
    return {
      loc: String(node.loc ?? ''),
      lastmod: node.lastmod ?? null,
      image_loc: img?.['image:loc'] ?? null,
      geo_location: img?.['image:geo_location'] ?? null,
    };
  });
}

/** Fetch the sitemap index and return absolute URLs of every rent-language leaf. */
export async function discoverRentLeaves(rootUrl: string, signal: AbortSignal): Promise<string[]> {
  const res = await request(rootUrl, { signal, method: 'GET' });
  if (res.statusCode !== 200) throw new Error(`sitemap index responded ${res.statusCode}`);
  const text = await res.body.text();
  const parsed = xml.parse(text) as { sitemapindex?: { sitemap?: unknown } };
  const items = parsed.sitemapindex?.sitemap;
  const list = Array.isArray(items) ? items : items ? [items] : [];
  return list
    .map((s) => (s as { loc?: string }).loc ?? '')
    .filter((l) => /pdp-\d+-sitemap-RENT-[a-z]+\.xml\.gz$/i.test(l));
}
