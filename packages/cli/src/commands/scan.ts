import type { Command } from 'commander';
export function registerScan(p: Command): void {
  p.command('scan').description('run pipeline once').action(async () => {});
}
