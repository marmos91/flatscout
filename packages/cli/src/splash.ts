const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

const BANNER = `${BOLD}██╗    ██╗  █████╗  ██████╗  ███████╗
██║    ██║ ██╔══██╗ ██╔══██╗ ██╔════╝
██║ █╗ ██║ ███████║ ██████╔╝ █████╗
██║███╗██║ ██╔══██║ ██╔══██╗ ██╔══╝
╚███╔███╔╝ ██║  ██║ ██████╔╝ ███████╗
 ╚══╝╚══╝  ╚═╝  ╚═╝ ╚═════╝  ╚══════╝${RESET}
            ${DIM}finding home in switzerland${RESET}`;

/** Returns the banner as a printable string. Skips ANSI when stdout is not a TTY. */
export function splash(): string {
  if (!process.stdout.isTTY) {
    return BANNER.replace(/\x1b\[\d+m/g, '');
  }
  return BANNER;
}
