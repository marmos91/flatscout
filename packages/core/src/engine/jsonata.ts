import jsonata from 'jsonata';

const cache = new Map<string, ReturnType<typeof jsonata>>();

/**
 * Compiles (with module-scoped LRU-free memoisation) and evaluates a JSONata
 * expression against `ctx`. Compiled programs are cached per expression
 * string, so repeated calls with the same `expr` avoid re-parsing.
 *
 * @throws when the expression fails to compile or evaluate.
 */
export async function evalJsonata(expr: string, ctx: unknown): Promise<unknown> {
  let compiled = cache.get(expr);
  if (!compiled) {
    compiled = jsonata(expr);
    cache.set(expr, compiled);
  }
  return compiled.evaluate(ctx);
}
