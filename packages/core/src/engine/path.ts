/**
 * Resolves a dotted-path string against a nested object.
 *
 * Returns `undefined` on any missing segment, traversal through `null`, or a
 * non-object intermediate. An empty path returns the root unchanged.
 *
 * @example resolvePath({ a: { b: { c: 1 } } }, 'a.b.c') === 1
 */
export function resolvePath(root: unknown, path: string): unknown {
  if (path === '') return root;
  const parts = path.split('.');
  let cur: unknown = root;
  for (const p of parts) {
    if (cur == null) return undefined;
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}
