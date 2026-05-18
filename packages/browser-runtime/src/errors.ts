/**
 * Error types raised by the browser-runtime cookie-harvesting flow.
 */

export class BootstrapError extends Error {
  override readonly name: string = 'BootstrapError';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class BootstrapTimeoutError extends BootstrapError {
  override readonly name: string = 'BootstrapTimeoutError';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
