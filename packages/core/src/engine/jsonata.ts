import jsonata from 'jsonata';

const cache = new Map<string, ReturnType<typeof jsonata>>();

export async function evalJsonata(expr: string, ctx: unknown): Promise<unknown> {
  let compiled = cache.get(expr);
  if (!compiled) {
    compiled = jsonata(expr);
    cache.set(expr, compiled);
  }
  return compiled.evaluate(ctx);
}
