import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, watch as fsWatch } from 'node:fs';
import { basename, dirname, resolve as resolvePath, join } from 'node:path';

/**
 * Tracks the SHA-256 of the extension's `dist/<browser>/src/background.js`
 * and re-hashes when the file changes on disk. Cheap fs.watch + on-demand
 * hash; no streaming since the bundle is small (~8 KB).
 */
export interface BundleHashTracker {
  /** Current hex-encoded hash, or null when the file isn't present. */
  current(): string | null;
  /** Stop the underlying fs.watch handle. Idempotent. */
  close(): void;
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function hashIfExists(p: string): string | null {
  try {
    if (!existsSync(p)) return null;
    if (!statSync(p).isFile()) return null;
    return sha256Hex(readFileSync(p));
  } catch {
    return null;
  }
}

/**
 * Start tracking `bundlePath`. The path is hashed eagerly; subsequent
 * mutations to the file trigger a re-hash (debounced via fs.watch's natural
 * event coalescing). On close, the watcher is released.
 */
export function startBundleHashTracker(bundlePath: string): BundleHashTracker {
  let hash: string | null = hashIfExists(bundlePath);
  // Watch the parent directory instead of the file itself. Bundlers (vite,
  // esbuild, webpack) commonly rewrite outputs by unlinking + renaming a
  // temp file into place; a file-level fs.watch keeps a dead inode handle
  // and never fires again after the first rewrite. Directory-level watch
  // catches every change and we re-hash on each event for the target file.
  const watchDir = dirname(bundlePath);
  const watchBase = basename(bundlePath);
  let watcher: ReturnType<typeof fsWatch> | null = null;
  try {
    watcher = fsWatch(watchDir, { persistent: false }, (_event, filename) => {
      if (filename && filename !== watchBase) return;
      hash = hashIfExists(bundlePath);
    });
  } catch {
    // Dir may not exist yet (first-build race) — leave hash null and let
    // future heartbeats omit `bundle_hash`. A daemon restart after the
    // first build picks it up.
  }
  return {
    current: () => hash,
    close: () => {
      if (watcher) {
        try {
          watcher.close();
        } catch {
          // ignore double-close
        }
        watcher = null;
      }
    },
  };
}

/**
 * Best-effort auto-discovery of the extension's background.js bundle path
 * by walking up from `cwd` looking for `apps/extension-flatscout/dist/<browser>/`.
 * Returns the first existing candidate; defaults to the `firefox` build
 * since that's the only one that benefits from auto-reload today (Chrome
 * MV3 reloads are blocked by Chrome's strict load-unpacked semantics
 * around `chrome.runtime.reload()` for self-hosted dev installs).
 */
export function autodetectBundlePath(cwd: string = process.cwd()): string | null {
  const candidates = ['firefox', 'chrome'];
  let dir = resolvePath(cwd);
  while (true) {
    for (const browser of candidates) {
      const candidate = join(dir, 'apps', 'extension-flatscout', 'dist', browser, 'src', 'background.js');
      if (existsSync(candidate)) return candidate;
    }
    const parent = resolvePath(dir, '..');
    if (parent === dir) return null;
    dir = parent;
  }
}
