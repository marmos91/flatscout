import type { Command } from 'commander';
import { registerPair } from './pair.js';
import { registerStatus } from './status.js';

export function registerBridge(program: Command): void {
  const bridge = program
    .command('bridge')
    .description('manage the browser bridge (browser-extension proxy)');
  registerPair(bridge);
  registerStatus(bridge);
}
