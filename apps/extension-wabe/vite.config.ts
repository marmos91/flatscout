import { defineConfig } from 'vite';
import webExtension from 'vite-plugin-web-extension';
import { resolve } from 'node:path';

/**
 * Bundles the Wabe Bridge extension as manifest-v3 for Chrome + Firefox.
 *
 * Output: `dist/`. Load that directory unpacked via `chrome://extensions`
 * (Developer mode → Load unpacked) or `about:debugging` → Load Temporary Add-on.
 */
export default defineConfig({
  plugins: [
    webExtension({
      manifest: resolve(__dirname, 'manifest.json'),
      additionalInputs: ['src/popup.html'],
      browser: process.env.WABE_EXT_BROWSER ?? 'chrome',
    }),
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
