import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectTransport } from '../src/transport.js';

const logger = pino({ level: 'silent' });

describe('selectTransport (is24)', () => {
  it('throws when no in-process bridge and no daemon heartbeat', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'wabe-is24-sel-'));
    await expect(selectTransport({ dataDir: tmp, logger })).rejects.toThrow(/browser bridge/i);
    rmSync(tmp, { recursive: true, force: true });
  });
});
