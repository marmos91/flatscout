export class FlatfoxHttpError extends Error {
  constructor(public status: number, public url: string, body?: string) {
    super(`flatfox HTTP ${status} for ${url}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
}

export class FlatfoxParseError extends Error {}
