import type { Command } from 'commander';
import { readHeartbeat } from '@wabe/server';
import { resolvePaths } from '../../paths.js';

const STALE_MS = 15_000;

/**
 * `wabe bridge status` — reads the heartbeat file written by the bridge server
 * inside `wabe start`. Reports connection state without itself opening a WS
 * connection (which would otherwise displace the paired extension).
 */
export function registerStatus(parent: Command): void {
  parent
    .command('status')
    .description('check whether the bridge server is running and the extension is connected')
    .action(() => {
      const globalOpts = parent.parent?.opts<{ config?: string; dataDir?: string }>() ?? {};
      const paths = resolvePaths({ config: globalOpts.config, dataDir: globalOpts.dataDir });
      const hb = readHeartbeat(paths.dataDir);
      if (!hb) {
        console.log('NOT REACHABLE — no heartbeat file. Is `wabe start` running with bridge.enabled: true?');
        process.exitCode = 1;
        return;
      }
      if (hb.age_ms > STALE_MS) {
        console.log(
          `STALE — heartbeat ${Math.round(hb.age_ms / 1000)}s old. wabe start may have crashed; restart it.`,
        );
        process.exitCode = 1;
        return;
      }
      if (!hb.connected) {
        console.log(
          `server reachable on port ${hb.port}, but no extension paired. Run \`wabe bridge pair\` and paste into the extension popup.`,
        );
        return;
      }
      const lastSeenAgoMs = hb.last_seen_at === 0 ? null : Date.now() - hb.last_seen_at;
      const lastSeenLabel = lastSeenAgoMs === null ? 'unknown' : `${Math.round(lastSeenAgoMs / 1000)}s ago`;
      console.log(
        `connected on port ${hb.port}; extension last seen ${lastSeenLabel}; ${hb.inflight} request(s) in-flight.`,
      );
    });
}
