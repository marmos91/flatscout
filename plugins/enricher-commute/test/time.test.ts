import { describe, it, expect } from 'vitest';
import { nextWeekdayAt, hhmmToMin } from '../src/time.js';

describe('hhmmToMin', () => {
  it('parses "08:30" → 510', () => {
    expect(hhmmToMin('08:30')).toBe(510);
  });
  it('parses "00:00" → 0', () => {
    expect(hhmmToMin('00:00')).toBe(0);
  });
  it('parses "23:59" → 1439', () => {
    expect(hhmmToMin('23:59')).toBe(1439);
  });
});

describe('nextWeekdayAt', () => {
  it('returns same-day local datetime when target weekday matches and time has not passed', () => {
    // 2026-05-18 is a Monday
    const now = new Date('2026-05-18T05:00:00');
    const out = nextWeekdayAt('mon', '08:30', now);
    expect(out.getDay()).toBe(1); // Monday
    expect(out.getHours()).toBe(8);
    expect(out.getMinutes()).toBe(30);
    expect(out.toDateString()).toBe(now.toDateString());
  });
  it('rolls forward when current time is past the target hour on the target day', () => {
    // Monday 10:00 → next Monday 08:30
    const now = new Date('2026-05-18T10:00:00');
    const out = nextWeekdayAt('mon', '08:30', now);
    expect(out.getDay()).toBe(1);
    const diffDays = Math.round((out.getTime() - now.getTime()) / 86_400_000);
    expect(diffDays).toBe(7);
  });
  it('finds the next occurrence of a future weekday', () => {
    const now = new Date('2026-05-18T10:00:00'); // Monday
    const out = nextWeekdayAt('thu', '09:00', now);
    expect(out.getDay()).toBe(4); // Thursday
  });
});
