import type { Command } from 'commander';
export function registerDoctor(p: Command): void {
  p.command('doctor').description('diagnose health').action(async () => {});
}
