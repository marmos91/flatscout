import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wabe-load-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('config loader', () => {
  it('parses a minimal valid config tree', async () => {
    writeFileSync(
      join(dir, 'config.yaml'),
      `enabled:
  sources: []
  notifiers: []
log:
  level: info
`,
    );
    writeFileSync(join(dir, 'filters.yaml'), 'filters: []\n');
    writeFileSync(
      join(dir, 'scoring.yaml'),
      `scoring:
  - {type: rule, name: x, weight: 1, metric: price.total, normalize: {type: linear, best: 1, worst: 2, invert: false}}
notify:
  threshold: 75
  daily_quota: 5
`,
    );
    const cfg = await loadConfig(dir);
    expect(cfg.top.enabled.sources).toEqual([]);
    expect(cfg.filters.filters).toEqual([]);
    expect(cfg.scoring.notify.threshold).toBe(75);
  });
});
