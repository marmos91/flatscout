#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import { registerInit } from './commands/init.js';
import { registerScan } from './commands/scan.js';
import { registerStart } from './commands/start.js';
import { registerList } from './commands/list.js';
import { registerMigrate } from './commands/migrate.js';
import { registerDoctor } from './commands/doctor.js';
import { registerPurge } from './commands/purge.js';

const program = new Command();
program
  .name('wabe')
  .description('Wabe — Swiss apartment hunting agent')
  .version('0.0.0')
  .option('-c, --config <dir>', 'config directory (overrides XDG)')
  .option('-d, --data-dir <dir>', 'data directory (overrides XDG)');

registerInit(program);
registerScan(program);
registerStart(program);
registerList(program);
registerMigrate(program);
registerDoctor(program);
registerPurge(program);

program.parseAsync().catch((err) => {
  console.error(err);
  process.exit(1);
});
