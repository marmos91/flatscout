import type { WabeDb } from '@wabe/db';

function utcDay(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Per-day notification quota counter persisted via the `quota_log` table.
 *
 * Days are keyed by UTC `YYYY-MM-DD`, so rollover happens at 00:00 UTC, not
 * local midnight. The counter is durable across process restarts and rebuilds
 * automatically each day (a fresh `INSERT ... ON CONFLICT` starts a new row
 * the first time the new day is consumed).
 */
export class Quota {
  constructor(
    private db: WabeDb,
    private dailyMax: number,
  ) {}

  /** Returns how many notifications may still be sent today (UTC). Zero if the cap is reached. */
  remaining(today: Date = new Date()): number {
    const day = utcDay(today);
    const row = this.db._raw
      .prepare<[string], { sent_count: number }>('SELECT sent_count FROM quota_log WHERE day = ?')
      .get(day);
    const used = row?.sent_count ?? 0;
    return Math.max(0, this.dailyMax - used);
  }

  /**
   * Atomically attempts to consume one quota slot for today (UTC). Returns
   * true on success (and increments the persisted counter), false if the cap
   * is already reached. The `WHERE sent_count < ?` guard in the UPSERT makes
   * the check-and-increment a single statement, safe against concurrent callers.
   */
  tryConsume(today: Date = new Date()): boolean {
    const day = utcDay(today);
    const cur = this.remaining(today);
    if (cur <= 0) return false;
    const upd = this.db._raw.prepare(
      `INSERT INTO quota_log (day, sent_count) VALUES (?, 1)
       ON CONFLICT(day) DO UPDATE SET sent_count = sent_count + 1
       WHERE quota_log.sent_count < ?`,
    );
    const r = upd.run(day, this.dailyMax);
    return r.changes > 0;
  }
}
