// plugins/enricher-commute/src/time.ts
type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

const WEEKDAY_INDEX: Record<Weekday, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

export function hhmmToMin(hhmm: string): number {
  const parts = hhmm.split(':').map(Number);
  const h = parts[0] ?? 0;
  const m = parts[1] ?? 0;
  return h * 60 + m;
}

export function nextWeekdayAt(weekday: Weekday, hhmm: string, now: Date = new Date()): Date {
  const target: number = WEEKDAY_INDEX[weekday] ?? 1;
  const parts = hhmm.split(':').map(Number);
  const h = parts[0] ?? 0;
  const m = parts[1] ?? 0;
  const out = new Date(now);
  out.setHours(h, m, 0, 0);
  const daysAhead = (target - now.getDay() + 7) % 7;
  if (daysAhead === 0 && out.getTime() <= now.getTime()) {
    out.setDate(out.getDate() + 7);
  } else {
    out.setDate(out.getDate() + daysAhead);
  }
  return out;
}
