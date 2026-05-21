import { request } from 'undici';
import { XMLParser } from 'fast-xml-parser';

export interface DetailUrl {
  loc: string;
  lastmod: string | null;
}

const xml = new XMLParser({ ignoreAttributes: false });

export async function fetchSitemap(url: string, signal: AbortSignal): Promise<DetailUrl[]> {
  const res = await request(url, {
    signal,
    method: 'GET',
    headers: { 'user-agent': 'Mozilla/5.0 flatscout/0' },
  });
  if (res.statusCode !== 200) throw new Error(`sitemap ${url} responded ${res.statusCode}`);
  return parseUrlset(await res.body.text());
}

export function parseUrlset(xmlText: string): DetailUrl[] {
  const parsed = xml.parse(xmlText) as { urlset?: { url?: unknown } };
  const urls = parsed.urlset?.url;
  const list = Array.isArray(urls) ? urls : urls ? [urls] : [];
  return list.map((u) => {
    const node = u as { loc?: string; lastmod?: string };
    return { loc: String(node.loc ?? ''), lastmod: node.lastmod ?? null };
  });
}
