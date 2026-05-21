import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildManifest } from '../build-manifest';

const baseManifest = JSON.parse(readFileSync(resolve(__dirname, '..', 'manifest.json'), 'utf8')) as Record<
  string,
  unknown
>;

describe('buildManifest', () => {
  describe('Chrome', () => {
    const out = buildManifest(baseManifest, 'chrome');

    it('emits a service_worker background entry (MV3 requirement)', () => {
      const bg = out.background as { service_worker?: string; scripts?: string[] };
      expect(bg.service_worker).toBeTypeOf('string');
      expect(bg.scripts).toBeUndefined();
    });

    it('includes the `offscreen` permission so the SW can spawn the WS host', () => {
      expect(out.permissions).toContain('offscreen');
    });

    it('does NOT set background.persistent (MV3 forbids it)', () => {
      const bg = out.background as Record<string, unknown>;
      expect(bg.persistent).toBeUndefined();
    });
  });

  describe('Firefox', () => {
    const out = buildManifest(baseManifest, 'firefox');

    it('emits a `scripts` background entry (Firefox MV3 ignores service_worker)', () => {
      const bg = out.background as { service_worker?: string; scripts?: string[] };
      expect(bg.service_worker).toBeUndefined();
      expect(Array.isArray(bg.scripts)).toBe(true);
      expect(bg.scripts).toContain('src/background.ts');
    });

    it('does NOT add the `offscreen` permission (Firefox would warn)', () => {
      const perms = out.permissions as string[];
      expect(perms).not.toContain('offscreen');
    });

    it('does NOT set background.persistent (Firefox MV3 manifest validator rejects it)', () => {
      const bg = out.background as Record<string, unknown>;
      expect(bg.persistent).toBeUndefined();
    });

    it('retains the existing storage permission (needed for storage.session keepalive)', () => {
      expect(out.permissions).toContain('storage');
    });

    it('retains the existing alarms permission (suspension wake-up path)', () => {
      expect(out.permissions).toContain('alarms');
    });

    it('keeps the gecko browser_specific_settings block intact', () => {
      const bss = out.browser_specific_settings as { gecko?: { id?: string } };
      expect(bss?.gecko?.id).toBeTypeOf('string');
    });
  });

  describe('isolation', () => {
    it('does not mutate the input manifest', () => {
      const snapshot = JSON.stringify(baseManifest);
      buildManifest(baseManifest, 'firefox');
      buildManifest(baseManifest, 'chrome');
      expect(JSON.stringify(baseManifest)).toBe(snapshot);
    });
  });
});
