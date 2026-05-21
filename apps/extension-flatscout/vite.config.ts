import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type Plugin, defineConfig } from 'vite';
import webExtension from 'vite-plugin-web-extension';
import { type ExtensionBrowser, buildManifest } from './build-manifest';

function copyRawAssets(files: Array<{ from: string; to: string }>): Plugin {
  return {
    name: 'flatscout-copy-raw-assets',
    apply: 'build',
    writeBundle(opts) {
      const outDir = opts.dir ?? 'dist';
      for (const f of files) {
        const dest = join(outDir, f.to);
        mkdirSync(join(dest, '..'), { recursive: true });
        copyFileSync(resolve(__dirname, f.from), dest);
      }
    },
  };
}

/**
 * Bundles the Flatscout Bridge extension as manifest-v3.
 *
 * Output: `dist/<browser>/` (e.g. `dist/chrome/`, `dist/firefox/`). Load that
 * directory unpacked via `chrome://extensions` (Developer mode → Load unpacked)
 * or `about:debugging` → Load Temporary Add-on.
 *
 * Firefox MV3 still ships with `background.service_worker` disabled — we have
 * to advertise the same entry point as `background.scripts` instead. Chrome
 * MV3 requires `service_worker`. We compute the right shape at build time
 * based on `FLATSCOUT_EXT_BROWSER` (see `./build-manifest.ts`).
 */
export default defineConfig(() => {
  const browserEnv = process.env.FLATSCOUT_EXT_BROWSER ?? 'chrome';
  if (browserEnv !== 'chrome' && browserEnv !== 'firefox') {
    throw new Error(`FLATSCOUT_EXT_BROWSER must be 'chrome' or 'firefox', got '${browserEnv}'`);
  }
  const browser: ExtensionBrowser = browserEnv;
  const baseManifest = JSON.parse(readFileSync(resolve(__dirname, 'manifest.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  // Firefox MV3: background suspends after ~30s idle. We deliberately do NOT
  // set `background.persistent: true` (MV3 rejects it). Instead, the runtime
  // background script layers `navigator.locks` + `chrome.storage.session`
  // writes on top of the existing alarm + setInterval — see
  // `src/background.ts:installFirefoxIdleHold`.
  // Chrome MV3: gets an extra `offscreen` permission so the SW can spawn a
  // persistent offscreen document that owns the WebSocket. Firefox would warn
  // on the unknown permission, so it's Chrome-only.
  const manifest = buildManifest(baseManifest, browser);
  return {
    plugins: [
      webExtension({
        manifest: () => manifest,
        additionalInputs:
          browser === 'chrome' ? ['src/popup.html', 'src/offscreen.html'] : ['src/popup.html'],
        browser,
      }),
      copyRawAssets([{ from: 'src/dnr-rules.json', to: 'src/dnr-rules.json' }]),
    ],
    build: {
      outDir: `dist/${browser}`,
      emptyOutDir: true,
    },
  };
});
