import type { Command } from 'commander';
export function registerMigrate(p: Command): void {
  p.command('migrate').description('apply migrations').action(async () => {});
}
