import type { Command } from 'commander';
export function registerStart(p: Command): void {
  p.command('start').description('run daemon').action(async () => {});
}
