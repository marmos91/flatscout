const ENV_RE = /\$\{env\.([A-Z0-9_]+)\}/g;

/**
 * Recursively substitutes `${env.VAR}` tokens inside any string fields of the
 * input value with the matching entry from `env` (default `process.env`).
 *
 * Recurses through arrays and plain objects; non-string scalars and null are
 * returned untouched. Tokens that resolve to an undefined environment variable
 * are replaced with the empty string (no error thrown). The return type
 * mirrors the input type by structural assertion — callers should still parse
 * the result through a Zod schema for runtime validation.
 */
export function interpolateEnv<T>(input: T, env: NodeJS.ProcessEnv = process.env): T {
  return walk(input, env) as T;
}

function walk(v: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof v === 'string') return v.replace(ENV_RE, (_, name) => env[name] ?? '');
  if (Array.isArray(v)) return v.map((x) => walk(x, env));
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val, env);
    return out;
  }
  return v;
}
