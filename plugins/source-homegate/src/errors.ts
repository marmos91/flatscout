/** Thrown when the Homegate API returns a non-2xx status that can't be retried. */
export class HomegateHttpError extends Error {
  constructor(
    public status: number,
    public url: string,
    public body?: string,
  ) {
    super(`homegate HTTP ${status} for ${url}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
}

/**
 * Thrown after a 403 + re-bootstrap retry has also returned 403. Signals that
 * DataDome is actively blocking the current install / IP fingerprint and a
 * fresh stealth handshake did not restore access.
 */
export class HomegateAntiBotError extends HomegateHttpError {
  constructor(url: string, body?: string) {
    super(403, url, body);
    this.message = `homegate anti-bot block (403) persisted after re-bootstrap for ${url}`;
  }
}

/**
 * Thrown when a user-bound endpoint (favourites, profile, token refresh)
 * returns 401/403 with semantics that mean "your token is invalid", not
 * "DataDome blocked you". Phase 3 wires this; Phase 2 ships it for symmetry.
 */
export class HomegateAuthError extends Error {
  constructor(
    public status: number,
    public url: string,
    public body?: string,
  ) {
    super(`homegate auth error ${status} for ${url}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
}

/** Thrown when the Homegate API response cannot be parsed into the expected shape. */
export class HomegateParseError extends Error {}
