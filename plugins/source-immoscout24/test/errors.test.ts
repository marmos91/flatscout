import { describe, expect, it } from 'vitest';
import { IS24HttpError, IS24AntiBotError, IS24ParseError } from '../src/errors.js';

describe('IS24HttpError', () => {
  it('serialises status + url in the message', () => {
    const err = new IS24HttpError(500, 'https://x', 'boom');
    expect(err.message).toContain('500');
    expect(err.message).toContain('https://x');
    expect(err.message).toContain('boom');
  });
});

describe('IS24AntiBotError', () => {
  it('hints at the bridge-refresh remedy', () => {
    const err = new IS24AntiBotError('https://x');
    expect(err.message).toMatch(/datadome/i);
    expect(err.message).toMatch(/paired browser/i);
  });
});

describe('IS24ParseError', () => {
  it('is an Error', () => {
    expect(new IS24ParseError('x')).toBeInstanceOf(Error);
  });
});
