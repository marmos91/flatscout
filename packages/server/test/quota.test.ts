import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, migrate } from '@wabe/db';
import { Quota } from '../src/quota.js';

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'wabe-q-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('Quota', () => {
  it('enforces daily cap and rolls over on UTC day change', () => {
    const db = openDb(join(dir, 'q.db'));
    migrate(db);
    const q = new Quota(db, 2);
    const day1 = new Date('2026-05-17T10:00:00Z');
    expect(q.tryConsume(day1)).toBe(true);
    expect(q.tryConsume(day1)).toBe(true);
    expect(q.tryConsume(day1)).toBe(false);
    const day2 = new Date('2026-05-18T00:01:00Z');
    expect(q.tryConsume(day2)).toBe(true);
  });

  it('remaining reflects consumed count', () => {
    const db = openDb(join(dir, 'q2.db'));
    migrate(db);
    const q = new Quota(db, 5);
    const d = new Date('2026-05-17T00:00:00Z');
    expect(q.remaining(d)).toBe(5);
    q.tryConsume(d);
    expect(q.remaining(d)).toBe(4);
  });
});
