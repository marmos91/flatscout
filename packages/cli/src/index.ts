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
import { registerLogin } from './commands/login.js';
import { registerLogout } from './commands/logout.js';
import { registerAgencies } from './commands/agencies/index.js';
import { registerBridge } from './commands/bridge/index.js';
import { registerCache } from './commands/cache.js';
import { registerDb } from './commands/db.js';
import { splash } from './splash.js';

const program = new Command();
program
  .name('wabe')
  .description('Wabe — Swiss apartment hunting agent')
  .version('0.0.0')
  .option('-c, --config <dir>', 'config directory (overrides XDG)')
  .option('-d, --data-dir <dir>', 'data directory (overrides XDG)')
  .addHelpText('beforeAll', `${splash()}\n`);

program
  .command('splash')
  .description('print the Wabe splash banner')
  .action(() => {
    console.log(splash());
  });

registerInit(program);
registerScan(program);
registerStart(program);
registerList(program);
registerMigrate(program);
registerDb(program);
registerDoctor(program);
registerPurge(program);
registerLogin(program);
registerLogout(program);
registerAgencies(program);
registerBridge(program);
registerCache(program);

program.parseAsync().catch((err) => {
  console.error(err);
  process.exit(1);
});
