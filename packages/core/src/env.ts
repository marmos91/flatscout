const ENV_RE = /\$\{env\.([A-Z0-9_]+)\}/g;

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
