import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import { resolvePaths } from '../paths.js';
import { openDb } from '@wabe/db';
import { migrate } from '@wabe/db';

const SAMPLE_CONFIG_YAML = `\
enabled:
  sources:
    - {name: flatfox-zurich,   plugin: source-flatfox,    config: plugins/source-flatfox.yaml}
    - {name: homegate-witikon, plugin: source-homegate,   config: plugins/source-homegate.yaml}
  notifiers:
    - {name: telegram, plugin: notifier-telegram, config: plugins/notifier-telegram.yaml}
log:
  level: info
`;

const SAMPLE_FILTERS_YAML = `\
filters:
  - {kind: field, field: rooms,         op: ">=", value: 3, on_missing: skip}
  - {kind: field, field: price.total,   op: "<=", value: 5000, on_missing: skip}
`;

const SAMPLE_SCORING_YAML = `\
scoring:
  - type: rule
    name: rent_value
    weight: 50
    metric: price.total
    on_missing: zero
    normalize: {type: linear, best: 2000, worst: 4000, invert: true}
  - type: rule
    name: size
    weight: 30
    metric: area_m2
    on_missing: zero
    normalize: {type: linear, best: 120, worst: 60, invert: false}
  - type: rule
    name: rooms_score
    weight: 20
    metric: rooms
    on_missing: zero
    normalize: {type: linear, best: 4.5, worst: 2.5, invert: false}
notify:
  threshold: 70
  daily_quota: 5
`;

function flatfoxSample(lat: number, lon: number, priceMax: number, roomsMin: number) {
  return `\
schedule: '*/5 * * * *'
search:
  cities: [Zürich]
  price_max: ${priceMax}
  rooms_min: ${roomsMin}
  surface_min: 60
  offer_type: RENT
  category: FLAT
fetch:
  page_size: 100
  max_pages: 3
  pace_ms: 2000
`;
}

function homegateSample(lat: number, lon: number, priceMax: number, roomsMin: number) {
  return `\
schedule: '*/5 * * * *'
auth:
  basic_user: '\${env.HOMEGATE_BASIC_USER}'
  basic_pass: '\${env.HOMEGATE_BASIC_PASS}'
  app_secret: '\${env.HOMEGATE_APP_SECRET}'
search:
  location: {lat: ${lat}, lon: ${lon}, radius_m: 2000}
  monthly_rent: {from: 1500, to: ${priceMax}}
  number_of_rooms: {from: ${roomsMin}, to: 6}
  living_space: {from: 60}
  categories: [APARTMENT]
  offer_type: RENT
fetch:
  page_size: 50
  max_pages: 2
  pace_ms: 5000
`;
}

const telegramSample = `\
bot_token: '\${env.TELEGRAM_BOT_TOKEN}'
chat_id:   '\${env.TELEGRAM_CHAT_ID}'
format: compact
`;

export function registerInit(prog: Command): void {
  prog
    .command('init')
    .description('Interactive setup: writes config + .env, runs migrate + doctor')
    .action(async () => {
      const globalOpts = prog.opts<{ config?: string; dataDir?: string }>();
      const paths = resolvePaths({ config: globalOpts.config, dataDir: globalOpts.dataDir });
      p.intro('wabe init');

      const tgToken = await p.text({ message: 'Telegram bot token (from @BotFather):' });
      if (p.isCancel(tgToken)) return p.cancel('aborted');
      const tgChat = await p.text({ message: 'Telegram chat id (numeric, e.g. 123456789):' });
      if (p.isCancel(tgChat)) return p.cancel('aborted');
      const lat = await p.text({ message: 'Search center latitude (default: 47.3553 = Witikon)', placeholder: '47.3553' });
      if (p.isCancel(lat)) return p.cancel('aborted');
      const lon = await p.text({ message: 'Search center longitude (default: 8.5839)', placeholder: '8.5839' });
      if (p.isCancel(lon)) return p.cancel('aborted');
      const priceMax = await p.text({ message: 'Max monthly rent CHF', placeholder: '4000' });
      if (p.isCancel(priceMax)) return p.cancel('aborted');
      const roomsMin = await p.text({ message: 'Min rooms', placeholder: '3.5' });
      if (p.isCancel(roomsMin)) return p.cancel('aborted');

      writeIfMissing(join(paths.configDir, 'config.yaml'), SAMPLE_CONFIG_YAML);
      writeIfMissing(join(paths.configDir, 'filters.yaml'), SAMPLE_FILTERS_YAML);
      writeIfMissing(join(paths.configDir, 'scoring.yaml'), SAMPLE_SCORING_YAML);
      mkdirSync(join(paths.configDir, 'plugins'), { recursive: true });
      writeIfMissing(
        join(paths.configDir, 'plugins', 'source-flatfox.yaml'),
        flatfoxSample(Number(lat), Number(lon), Number(priceMax), Number(roomsMin)),
      );
      writeIfMissing(
        join(paths.configDir, 'plugins', 'source-homegate.yaml'),
        homegateSample(Number(lat), Number(lon), Number(priceMax), Number(roomsMin)),
      );
      writeIfMissing(join(paths.configDir, 'plugins', 'notifier-telegram.yaml'), telegramSample);
      writeIfMissing(
        join(process.cwd(), '.env'),
        `TELEGRAM_BOT_TOKEN=${tgToken}\nTELEGRAM_CHAT_ID=${tgChat}\n# HOMEGATE_BASIC_USER=...\n# HOMEGATE_BASIC_PASS=...\n# HOMEGATE_APP_SECRET=...\n`,
      );
      const db = openDb(paths.dbFile);
      const m = migrate(db);
      p.note(`config: ${paths.configDir}\ndata:   ${paths.dataDir}\nmigrations applied: ${m.applied.length}`);
      p.outro('done — run `wabe doctor` to verify, then `wabe scan`.');
    });
}

function writeIfMissing(file: string, content: string): void {
  if (existsSync(file)) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}
