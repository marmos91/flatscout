const ESC = String.fromCharCode(0x1b);
const DIM = `${ESC}[2m`;
const BOLD = `${ESC}[1m`;
const RESET = `${ESC}[0m`;

const BANNER = `${BOLD}██╗    ██╗  █████╗  ██████╗  ███████╗
██║    ██║ ██╔══██╗ ██╔══██╗ ██╔════╝
██║ █╗ ██║ ███████║ ██████╔╝ █████╗
██║███╗██║ ██╔══██║ ██╔══██╗ ██╔══╝
╚███╔███╔╝ ██║  ██║ ██████╔╝ ███████╗
 ╚══╝╚══╝  ╚═╝  ╚═╝ ╚═════╝  ╚══════╝${RESET}
            ${DIM}finding home in switzerland${RESET}`;

const ANSI_RE = new RegExp(`${ESC}\\[\\d+m`, 'g');

/** Returns the banner as a printable string. Skips ANSI when stdout is not a TTY. */
export function splash(): string {
  if (!process.stdout.isTTY) {
    return BANNER.replace(ANSI_RE, '');
  }
  return BANNER;
}
