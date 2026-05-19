/** Thrown when the ImmoScout24 API returns a non-2xx status that can't be retried. */
export class IS24HttpError extends Error {
  constructor(
    public status: number,
    public url: string,
    public body?: string,
  ) {
    super(`immoscout24 HTTP ${status} for ${url}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
}

/**
 * Thrown when the ImmoScout24 API returns a 403 that the bridge transport could
 * not transparently recover from. DataDome binds its cookie to the user's
 * real browser session — recover by opening https://www.immoscout24.ch/ in
 * the paired browser once to refresh the session.
 */
export class IS24AntiBotError extends IS24HttpError {
  constructor(url: string, body?: string) {
    super(403, url, body);
    this.message = `immoscout24 DataDome blocked ${url} — open https://www.immoscout24.ch/ in your paired browser once to refresh the session`;
  }
}

/** Thrown when the ImmoScout24 API response cannot be parsed into the expected shape. */
export class IS24ParseError extends Error {}
