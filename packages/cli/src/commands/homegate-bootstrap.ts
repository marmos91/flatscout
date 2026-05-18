import type { Command } from 'commander';
import * as p from '@clack/prompts';
import { bootstrapSite, type BootstrapResult } from '@wabe/browser-runtime';
import { saveCookies } from '@wabe/source-homegate';
import { resolvePaths } from '../paths.js';

/**
 * Default deep search URL that triggers the high-friction DataDome tier.
 * Cookies harvested from this URL (after the user solves the CAPTCHA)
 * clear `api.homegate.ch/search/listings`. The low-friction `/rent`
 * landing page does not produce such cookies — see
 * `docs/research/2026-05-18-homegate-web-xhr-probe.md`.
 */
const DEFAULT_TARGET = 'https://www.homegate.ch/rent/real-estate/canton-zurich/matching-list';

/**
 * Registers the `wabe homegate-bootstrap` subcommand.
 *
 * Opens a real (headed) stealth Chromium pointed at a Homegate search
 * page, waits for the user to interactively solve any DataDome CAPTCHA
 * presented, then harvests the resulting cookies into the data dir so
 * subsequent `wabe scan --source homegate-zurich` runs can use the
 * high-trust cookie tier required to reach `api.homegate.ch`.
 *
 * Required because pure-headless automation cannot pass DataDome on
 * Homegate's high-friction endpoints; cookies live ~12h after a solve,
 * so the user reruns this command between scan windows.
 */
export function registerHomegateBootstrap(prog: Command): void {
  prog
    .command('homegate-bootstrap')
    .description('Open a visible browser to manually solve DataDome and harvest cookies')
    .option('--target <url>', 'override the search URL to navigate to', DEFAULT_TARGET)
    .action(async (opts: { target: string }) => {
      const globalOpts = prog.opts<{ config?: string; dataDir?: string }>();
      const paths = resolvePaths({ config: globalOpts.config, dataDir: globalOpts.dataDir });

      p.intro('homegate-bootstrap');
      p.note(
        [
          'A real Chromium window will open and navigate to:',
          `  ${opts.target}`,
          '',
          'When you see search results (solving any CAPTCHA shown), come back',
          'here and confirm to harvest cookies.',
        ].join('\n'),
      );

      let result: BootstrapResult;
      try {
        result = await bootstrapSite({
          target: opts.target,
          headless: false,
          // Interactive mode: don't wait for networkidle (CAPTCHA frames keep
          // polling). The waitForUser hook is the real "page is ready" signal.
          waitUntil: 'domcontentloaded',
          timeoutMs: 60_000,
          waitForUser: async () => {
            const confirmed = await p.confirm({
              message: 'Search results visible (CAPTCHA solved if any)?',
              initialValue: true,
            });
            if (p.isCancel(confirmed) || !confirmed) {
              throw new Error('user aborted bootstrap');
            }
          },
        });
      } catch (err) {
        p.cancel(`bootstrap failed: ${(err as Error).message}`);
        process.exit(1);
      }

      await saveCookies(paths.dataDir, result);

      p.outro(
        `✓ harvested ${result.cookies.length} cookie${result.cookies.length === 1 ? '' : 's'} → ${paths.dataDir}/homegate-cookies.json`,
      );
    });
}
