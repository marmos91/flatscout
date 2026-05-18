import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Command } from 'commander';
import { request } from 'undici';
import { loadConfig, loadPlugins, loadSecrets } from '@wabe/server';
import { openDb } from '@wabe/db';
import { resolvePaths } from '../paths.js';

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
      try {
        const cfg = await loadConfig(paths.configDir);
        result('config files parse', true, `config dir: ${paths.configDir}`);
        const rentalDetail =
          cfg.rentalTerm.mode === 'short'
            ? `mode=short${cfg.rentalTerm.stay ? ' (stay constraints set)' : ''}`
            : `mode=long, exclude_unknown=${cfg.rentalTerm.exclude_unknown}`;
        result('rental_term policy', true, rentalDetail);
        try {
          const loaded = await loadPlugins(cfg);
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

      process.exit(ok ? 0 : 1);
    });
}
