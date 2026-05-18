import type { Command } from 'commander';
import { registerProbe } from './probe.js';
import { registerProbePortal } from './probe-portal.js';
import { registerValidate } from './validate.js';
import { registerStats } from './stats.js';

export function registerAgencies(program: Command): void {
  const agencies = program.command('agencies').description('manage the agency registry');
  registerProbe(agencies);
  registerProbePortal(agencies);
  registerValidate(agencies);
  registerStats(agencies);
}
