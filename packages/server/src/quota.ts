import type { WabeDb } from '@wabe/db';

function utcDay(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export class Quota {
  constructor(
    private db: WabeDb,
    private dailyMax: number,
  ) {}

  remaining(today: Date = new Date()): number {
    const day = utcDay(today);
    const row = this.db._raw
      .prepare<[string], { sent_count: number }>('SELECT sent_count FROM quota_log WHERE day = ?')
      .get(day);
    const used = row?.sent_count ?? 0;
    return Math.max(0, this.dailyMax - used);
  }

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
