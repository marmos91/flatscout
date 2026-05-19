import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import webExtension from 'vite-plugin-web-extension';

function copyRawAssets(files: Array<{ from: string; to: string }>): Plugin {
  return {
    name: 'wabe-copy-raw-assets',
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
 * Bundles the Wabe Bridge extension as manifest-v3.
 *
 * Output: `dist/<browser>/` (e.g. `dist/chrome/`, `dist/firefox/`). Load that
 * directory unpacked via `chrome://extensions` (Developer mode → Load unpacked)
 * or `about:debugging` → Load Temporary Add-on.
 *
 * Firefox MV3 still ships with `background.service_worker` disabled — we have
 * to advertise the same entry point as `background.scripts` instead. Chrome
 * MV3 requires `service_worker`. We compute the right shape at build time
 * based on `WABE_EXT_BROWSER`.
 */
export default defineConfig(() => {
  const browser = process.env.WABE_EXT_BROWSER ?? 'chrome';
  const baseManifest = JSON.parse(readFileSync(resolve(__dirname, 'manifest.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  const manifest = { ...baseManifest } as Record<string, unknown>;
  if (browser === 'firefox') {
    manifest.background = { scripts: ['src/background.ts'] };
  }
  return {
    plugins: [
      webExtension({
        manifest: () => manifest,
        additionalInputs: ['src/popup.html'],
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
