import { request, type Dispatcher } from 'undici';

const HOST = 'https://flatfox.ch';

/**
 * Best-effort cover-image extractor from a Flatfox listing detail page.
 *
 * Flatfox's public JSON API only exposes integer image IDs, not URLs (the
 * filename-hash that builds the CDN URL is server-side only). The detail
 * HTML page, however, carries an Open Graph `og:image` meta tag with the
 * cover photo's full URL. We fetch that page and pull the URL out.
 *
 * Returns null on any failure (non-2xx response, missing meta tag, parse
 * error) — photos are nice-to-have, never load-bearing, so the caller
 * keeps the listing without a photo rather than aborting.
 */
export async function fetchCoverPhoto(
  detailUrl: string,
  opts: { signal: AbortSignal; pool?: Dispatcher },
): Promise<string | null> {
  try {
    const path = new URL(detailUrl).pathname;
    const res = opts.pool
      ? await opts.pool.request({
          method: 'GET',
          path,
          signal: opts.signal,
          headers: {
            accept: 'text/html',
            'user-agent': 'wabe-source-flatfox/0.1 (+https://github.com)',
          },
        })
      : await request(detailUrl, {
          method: 'GET',
          signal: opts.signal,
          headers: {
            accept: 'text/html',
            'user-agent': 'wabe-source-flatfox/0.1 (+https://github.com)',
          },
        });
    if (res.statusCode < 200 || res.statusCode >= 400) {
      await res.body.dump();
      return null;
    }
    const html = await res.body.text();
    return extractOgImage(html);
  } catch {
    return null;
  }
}

/**
 * Parses the cover-photo URL from a Flatfox detail page's `og:image` meta
 * tag. The page emits a relative path (`/thumb/ff/.../<hash>.jpg?...`);
 * we resolve it against the Flatfox host and decode any HTML entities
 * (notably `&amp;` in the signature query string).
 *
 * Exported for unit-testing against committed HTML fixtures.
 */
export function extractOgImage(html: string): string | null {
  const m = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
  if (!m?.[1]) return null;
  const raw = m[1].replace(/&amp;/g, '&');
  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
  if (raw.startsWith('/')) return `${HOST}${raw}`;
  return null;
}
