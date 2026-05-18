import { join } from 'node:path';
import readline from 'node:readline';
import type { Command } from 'commander';
import { bootstrapSite, type BootstrapResult } from '@wabe/browser-runtime';
import { saveCookies } from '@wabe/source-homegate';
import { resolvePaths } from '../paths.js';

/** Plain readline prompt, avoids @clack/prompts TTY edge cases when this
 * command is invoked alongside a long-running headed browser. */
function waitForEnter(message: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${message} `, () => {
      rl.close();
      resolve();
    });
  });
}

/**
 * Default landing URL. The user navigates from here to a real search in the
 * visible browser — using the homegate search UI like a normal visitor.
 * Starting at the gentle `/rent` landing avoids DataDome's hard ban on
 * direct-to-deep-URL automation; the user's subsequent in-page navigation
 * produces the high-trust cookies needed for `api.homegate.ch`.
 */
const DEFAULT_TARGET = 'https://www.homegate.ch/rent';

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

      console.log('');
      console.log('homegate-bootstrap');
      console.log('');
      console.log(`A Chromium window will open at:\n  ${opts.target}`);
      console.log('');
      console.log('In the browser: use the search UI to filter for your area / price / rooms,');
      console.log('then hit search. When you see real listings render, come back here and');
      console.log('press Enter to harvest the cookies.');
      console.log('');
      console.log('If DataDome shows a CAPTCHA at any point, solve it before pressing Enter.');
      console.log('');

      let result: BootstrapResult;
      try {
        result = await bootstrapSite({
          target: opts.target,
          headless: false,
          // Firefox over Marionette has a different protocol fingerprint
          // than CDP-driven Chromium; DataDome appears to pass Firefox
          // where it walls Playwright's Chromium binary.
          engine: 'firefox',
          // Persist the profile so DataDome scores us as a returning
          // visitor on subsequent bootstrap runs.
          userDataDir: join(paths.dataDir, 'homegate-browser-profile'),
          // Interactive mode: don't wait for networkidle (CAPTCHA frames keep
          // polling). The waitForUser hook is the real "page is ready" signal.
          waitUntil: 'domcontentloaded',
          timeoutMs: 60_000,
          waitForUser: () => waitForEnter('[press Enter when ready]'),
        });
      } catch (err) {
        const e = err as Error & { cause?: unknown };
        const causeMsg = e.cause instanceof Error ? e.cause.message : e.cause ? String(e.cause) : '';
        console.error(`✗ bootstrap failed: ${e.message}${causeMsg ? `\n  cause: ${causeMsg}` : ''}`);
        process.exit(1);
      }

      await saveCookies(paths.dataDir, result);

      console.log(
        `✓ harvested ${result.cookies.length} cookie${result.cookies.length === 1 ? '' : 's'} → ${paths.dataDir}/homegate-cookies.json`,
      );
    });
}
