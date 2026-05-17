import { describe, expect, it } from 'vitest';
import { interpolateEnv } from '../src/env.js';

describe('interpolateEnv', () => {
  it('replaces ${env.FOO} with process.env.FOO', () => {
    process.env.TEST_FOO = 'bar';
    expect(interpolateEnv('${env.TEST_FOO}', process.env)).toBe('bar');
  });
  it('leaves unset vars as empty string when no default', () => {
    expect(interpolateEnv('${env.NEVER_SET_XYZ}', {})).toBe('');
  });
  it('walks nested objects + arrays', () => {
    const r = interpolateEnv({ a: '${env.X}', b: ['${env.X}', 1] }, { X: 'v' });
    expect(r).toEqual({ a: 'v', b: ['v', 1] });
  });
  it('leaves non-${env.…} strings untouched', () => {
    expect(interpolateEnv('plain', {})).toBe('plain');
    expect(interpolateEnv('${other.var}', {})).toBe('${other.var}');
  });
});
