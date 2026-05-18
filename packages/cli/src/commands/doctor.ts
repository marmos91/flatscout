import { Command } from 'commander';
import { request } from 'undici';
import { loadConfig, loadPlugins } from '@wabe/server';
import { openDb } from '@wabe/db';
import { resolvePaths } from '../paths.js';

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
        const cfg = loadConfig(paths.configDir);
        result('config files parse', true, `config dir: ${paths.configDir}`);
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
      process.exit(ok ? 0 : 1);
    });
}
