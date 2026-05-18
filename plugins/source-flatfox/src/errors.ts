/** Thrown when the Flatfox API returns a non-2xx status that can't be retried. */
export class FlatfoxHttpError extends Error {
  constructor(
    public status: number,
    public url: string,
    body?: string,
  ) {
    super(`flatfox HTTP ${status} for ${url}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
}

/** Thrown when the Flatfox API response cannot be parsed into the expected shape. */
export class FlatfoxParseError extends Error {}
