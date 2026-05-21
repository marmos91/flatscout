/**
 * Per-browser manifest generation.
 *
 * Pure function: given the base `manifest.json` and a target browser, returns
 * the manifest the build should emit into `dist/<browser>/`. Kept separate
 * from `vite.config.ts` so it can be exercised in unit tests without
 * spawning a full vite build.
 *
 * The two divergences between Chrome and Firefox bundles:
 *
 *  1. **Background entry shape.** Chrome MV3 requires
 *     `background.service_worker`. Firefox MV3 ignores
 *     `background.service_worker` and requires `background.scripts`. We
 *     deliberately do NOT set `background.persistent: true` for Firefox —
 *     MV3's manifest validator rejects it. Keep-alive is handled at runtime
 *     (see `src/background.ts` → `installFirefoxIdleHold`).
 *
 *  2. **`offscreen` permission.** Only Chrome supports
 *     `chrome.offscreen.createDocument`, so the permission is added to the
 *     Chrome manifest only. Firefox would warn on the unknown permission.
 */
export type ExtensionBrowser = 'chrome' | 'firefox';

export function buildManifest(
  baseManifest: Readonly<Record<string, unknown>>,
  browser: ExtensionBrowser,
): Record<string, unknown> {
  const manifest: Record<string, unknown> = { ...baseManifest };
  if (browser === 'firefox') {
    manifest.background = { scripts: ['src/background.ts'] };
    return manifest;
  }
  // chrome
  const perms = Array.isArray(manifest.permissions) ? [...(manifest.permissions as string[])] : [];
  if (!perms.includes('offscreen')) perms.push('offscreen');
  manifest.permissions = perms;
  return manifest;
}
