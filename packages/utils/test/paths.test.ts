import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveDataDir } from '../src/paths.js';

describe('resolveDataDir', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    const next: NodeJS.ProcessEnv = { ...originalEnv };
    next.FLATSCOUT_DATA_DIR = undefined;
    next.XDG_DATA_HOME = undefined;
    process.env = next;
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('honours FLATSCOUT_DATA_DIR', () => {
    process.env.FLATSCOUT_DATA_DIR = '/tmp/explicit';
    expect(resolveDataDir()).toBe('/tmp/explicit');
  });

  it('falls back to XDG_DATA_HOME/flatscout', () => {
    process.env.XDG_DATA_HOME = '/tmp/xdg';
    expect(resolveDataDir()).toBe('/tmp/xdg/flatscout');
  });

  it('falls back to ~/.local/share/flatscout', () => {
    const dir = resolveDataDir();
    expect(dir.endsWith('/.local/share/flatscout')).toBe(true);
  });
});
