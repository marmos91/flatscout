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
