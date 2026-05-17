import { describe, expect, it } from 'vitest';
import { resolvePath } from '../src/engine/path.js';

describe('resolvePath', () => {
  const obj = { a: { b: { c: 1 } }, list: [{ x: 10 }, { x: 20 }], nul: null };
  it('resolves nested', () => expect(resolvePath(obj, 'a.b.c')).toBe(1));
  it('returns undefined on missing key', () => expect(resolvePath(obj, 'a.b.z')).toBeUndefined());
  it('returns undefined when traversing through null', () => expect(resolvePath(obj, 'nul.x')).toBeUndefined());
  it('handles array index', () => expect(resolvePath(obj, 'list.0.x')).toBe(10));
  it('returns top-level when path empty', () => expect(resolvePath(obj, '')).toBe(obj));
});
