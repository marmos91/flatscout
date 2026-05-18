import type { Command } from 'commander';
export function registerList(p: Command): void {
  p.command('list').description('list listings').action(async () => {});
}
