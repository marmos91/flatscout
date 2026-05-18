import type { Command } from 'commander';
export function registerInit(p: Command): void {
  p.command('init').description('interactive setup').action(async () => {});
}
