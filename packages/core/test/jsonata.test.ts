import { describe, expect, it } from 'vitest';
import { evalJsonata } from '../src/engine/jsonata.js';

describe('evalJsonata', () => {
  it('evaluates a simple expression against an object', async () => {
    expect(await evalJsonata('a + b', { a: 1, b: 2 })).toBe(3);
  });
  it('returns undefined when path missing', async () => {
    expect(await evalJsonata('foo.bar', { foo: null })).toBeUndefined();
  });
  it('handles boolean expression', async () => {
    expect(await evalJsonata('rooms > 3', { rooms: 4 })).toBe(true);
  });
});
