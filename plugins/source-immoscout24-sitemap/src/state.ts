import type { WabeDb } from '@wabe/db';

const SOURCE_NAME = 'source-immoscout24-sitemap';

/** Returns the set of canonical detail URLs we already emitted on a previous scan, or null on first run. */
export function loadSeenUrls(db: WabeDb): Set<string> | null {
  const row = db._raw
    .prepare<[string], { state: string }>('SELECT state FROM sitemap_state WHERE source = ?')
    .get(SOURCE_NAME);
  if (!row) return null;
  try {
    const arr = JSON.parse(row.state) as string[];
    return new Set(arr);
  } catch {
    return null;
  }
}

export function saveSeenUrls(db: WabeDb, urls: Set<string>): void {
  const now = Date.now();
  const payload = JSON.stringify([...urls]);
  db._raw
    .prepare(
      'INSERT INTO sitemap_state (source, last_seen_at, state) VALUES (?,?,?) ON CONFLICT(source) DO UPDATE SET last_seen_at = excluded.last_seen_at, state = excluded.state',
    )
    .run(SOURCE_NAME, now, payload);
}
