import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Command } from 'commander';
import { request } from 'undici';
import { loadConfig, loadPlugins, loadSecrets, readHeartbeat } from '@wabe/server';
import { openDb } from '@wabe/db';
import { resolvePaths } from '../paths.js';

/** Sources that route through DataDome-protected APIs and therefore require the bridge. */
const DATADOME_SOURCES = ['source-homegate', 'source-immoscout24-sitemap'] as const;

/** Compact relative-time formatter — `"3h ago"`, `"2d ago"`, `"45s ago"`. */
function relAge(epochMs: number): string {
  const deltaS = Math.max(0, Math.floor((Date.now() - epochMs) / 1000));
  if (deltaS < 60) return `${deltaS}s ago`;
  if (deltaS < 3600) return `${Math.floor(deltaS / 60)}m ago`;
  if (deltaS < 86400) return `${Math.floor(deltaS / 3600)}h ago`;
  return `${Math.floor(deltaS / 86400)}d ago`;
}

/** Registers the `wabe doctor` subcommand: probes config, DB, plugin loading, and external APIs. */
export function registerDoctor(prog: Command): void {
  prog
    .command('doctor')
    .description('Diagnose config / DB / plugin / network health')
    .action(async () => {
      const globalOpts = prog.opts<{ config?: string; dataDir?: string }>();
      const paths = resolvePaths({ config: globalOpts.config, dataDir: globalOpts.dataDir });
      let ok = true;
      const result = (label: string, pass: boolean, detail?: string) => {
        const tag = pass ? 'OK ' : 'FAIL';
        console.log(`[${tag}] ${label}${detail ? ` — ${detail}` : ''}`);
        if (!pass) ok = false;
      };
      let loadedCfg: Awaited<ReturnType<typeof loadConfig>> | null = null;
      let loadedSources: Array<{ name: string }> | null = null;
      try {
        const cfg = await loadConfig(paths.configDir);
        loadedCfg = cfg;
        result('config files parse', true, `config dir: ${paths.configDir}`);
        const rentalDetail =
          cfg.rentalTerm.mode === 'short'
            ? `mode=short${cfg.rentalTerm.stay ? ' (stay constraints set)' : ''}`
            : `mode=long, exclude_unknown=${cfg.rentalTerm.exclude_unknown}`;
        result('rental_term policy', true, rentalDetail);
        try {
          const loaded = await loadPlugins(cfg);
          loadedSources = loaded.sources;
          result(
            'plugins resolve + configs validate',
            true,
            `${loaded.sources.length} sources, ${loaded.notifiers.length} notifiers`,
          );
        } catch (e) {
          result('plugins resolve + configs validate', false, (e as Error).message);
        }
      } catch (e) {
        result('config files parse', false, (e as Error).message);
      }
      try {
        const db = openDb(paths.dbFile);
        db._raw.prepare('SELECT 1').get();
        result('db reachable', true, paths.dbFile);
      } catch (e) {
        result('db reachable', false, (e as Error).message);
      }
      const tgToken = process.env.TELEGRAM_BOT_TOKEN;
      if (!tgToken) {
        result('telegram bot token (env)', false, 'TELEGRAM_BOT_TOKEN not set');
      } else {
        try {
          const r = await request(`https://api.telegram.org/bot${tgToken}/getMe`);
          const body = (await r.body.json()) as { ok: boolean };
          result('telegram getMe', body.ok === true, `HTTP ${r.statusCode}`);
        } catch (e) {
          result('telegram getMe', false, (e as Error).message);
        }
      }
      try {
        const r = await request('https://flatfox.ch/api/v1/public-listing/?status=act&limit=1');
        result('flatfox API reachable', r.statusCode >= 200 && r.statusCode < 400, `HTTP ${r.statusCode}`);
      } catch (e) {
        result('flatfox API reachable', false, (e as Error).message);
      }
      // Informational homegate checks — these NEVER fail the overall
      // doctor exit code; they exist to make state-debugging easier.
      try {
        await stat(join(paths.dataDir, 'homegate-install.json'));
        result('homegate install present', true, 'yes');
      } catch {
        result('homegate install present', true, 'not yet (first scan will generate)');
      }
      try {
        const raw = await readFile(join(paths.dataDir, 'homegate-cookies.json'), 'utf8');
        const parsed = JSON.parse(raw) as { capturedAt?: number };
        if (typeof parsed.capturedAt === 'number') {
          const age = relAge(parsed.capturedAt);
          const fresh = parsed.capturedAt + 12 * 3600_000 > Date.now();
          result('homegate cookies fresh', true, `${fresh ? 'fresh' : 'stale'} (captured ${age})`);
        } else {
          result('homegate cookies fresh', true, 'present but malformed');
        }
      } catch {
        result('homegate cookies fresh', true, 'absent (will harvest on first scan)');
      }
      try {
        const secrets = await loadSecrets(paths.dataDir);
        if (secrets.homegate?.refreshToken) {
          const who = secrets.homegate.userSub ?? 'unknown';
          result('homegate user token', true, `logged in as ${who}`);
        } else {
          result('homegate user token', true, 'not logged in (optional)');
        }
      } catch (e) {
        result('homegate user token', true, `(skipped: ${(e as Error).message})`);
      }

      // Browser bridge — only reported when enabled in config. Always informational
      // (never fails overall exit) because a missing heartbeat may just mean the daemon
      // isn't running right now.
      if (loadedCfg?.top.bridge.enabled) {
        const hb = readHeartbeat(paths.dataDir);
        if (!hb) {
          result('browser bridge', true, 'enabled but no heartbeat — is `wabe start` running?');
        } else if (hb.age_ms > 15_000) {
          result('browser bridge', true, `stale (heartbeat ${Math.round(hb.age_ms / 1000)}s old)`);
        } else if (!hb.connected) {
          result('browser bridge', true, `server up on port ${hb.port}, no extension paired`);
        } else {
          const lastSeen =
            hb.last_seen_at === 0 ? 'unknown' : `${Math.round((Date.now() - hb.last_seen_at) / 1000)}s ago`;
          result('browser bridge', true, `connected on port ${hb.port}, extension last seen ${lastSeen}`);
        }
      }

      // Hard-fail: DataDome-protected sources require a paired + connected bridge.
      // Without it, those sources will error on every scan, so surface the misconfiguration
      // early via a non-zero doctor exit.
      const enabledDataDomeSources =
        loadedSources
          ?.filter((s) => (DATADOME_SOURCES as readonly string[]).includes(s.name))
          .map((s) => s.name) ?? [];
      if (enabledDataDomeSources.length > 0) {
        const hb = readHeartbeat(paths.dataDir);
        const bridgeOk =
          loadedCfg?.top.bridge.enabled === true && hb !== null && hb.age_ms < 15_000 && hb.connected;
        if (!bridgeOk) {
          result(
            'bridge required by DataDome sources',
            false,
            `sources [${enabledDataDomeSources.join(', ')}] need bridge paired+connected. Enable \`top.bridge.enabled\` and run \`wabe bridge pair\` + \`wabe start\`.`,
          );
        } else {
          result('bridge required by DataDome sources', true, enabledDataDomeSources.join(', '));
        }
      }

      process.exit(ok ? 0 : 1);
    });
}
