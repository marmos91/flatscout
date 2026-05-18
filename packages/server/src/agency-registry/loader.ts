import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { request } from 'undici';
import { parse as parseYaml } from 'yaml';
import { AgencyRegistry } from '@wabe/core';

export interface LoadRegistryOpts {
  /** Registry source: local path, `https://...`, or `git+ssh://...#branch`. */
  registry: string;
  /** Optional bearer token for HTTPS GET. */
  registry_auth?: string;
  /** Base directory used to resolve relative file paths. */
  configDir: string;
  signal: AbortSignal;
}

/** Load + parse + validate a registry from any supported source. Throws on failure. */
export async function loadRegistry(opts: LoadRegistryOpts): Promise<AgencyRegistry> {
  const text = await fetchRegistryText(opts);
  const raw = parseYaml(text) as unknown;
  return AgencyRegistry.parse(raw);
}

async function fetchRegistryText(opts: LoadRegistryOpts): Promise<string> {
  const r = opts.registry;
  if (r.startsWith('https://') || r.startsWith('http://')) {
    return fetchHttp(r, opts);
  }
  if (r.startsWith('git+')) {
    return fetchGit(r, opts);
  }
  // local path
  const full = isAbsolute(r) ? r : resolve(opts.configDir, r);
  if (!existsSync(full)) throw new Error(`registry file not found: ${full}`);
  return readFileSync(full, 'utf8');
}

async function fetchHttp(url: string, opts: LoadRegistryOpts): Promise<string> {
  const headers: Record<string, string> = { accept: 'text/yaml, application/yaml, text/plain' };
  if (opts.registry_auth) headers.authorization = `Bearer ${opts.registry_auth}`;
  const res = await request(url, { method: 'GET', headers, signal: opts.signal });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`registry HTTP ${res.statusCode} for ${url}`);
  }
  return res.body.text();
}

/**
 * Shallow-clones a git registry repo into a temp dir, reads `agencies.yaml`
 * from the repo root (or the path after `#`), then removes the tempdir.
 * URL form: `git+ssh://user@host/repo.git#branch:path` (branch and path optional).
 */
function fetchGit(url: string, opts: LoadRegistryOpts): Promise<string> {
  const stripped = url.replace(/^git\+/, '');
  const [base, frag = ''] = stripped.split('#', 2) as [string, string | undefined];
  const [branch = '', relPath = 'agencies.yaml'] = frag.split(':', 2);
  const tmp = mkdtempSync(join(tmpdir(), 'wabe-reg-git-'));
  try {
    const cloneArgs = ['clone', '--depth=1', '--quiet', ...(branch ? ['--branch', branch] : []), base, tmp];
    execFileSync('git', cloneArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
    if (opts.signal.aborted) throw new Error('aborted');
    const fullPath = join(tmp, relPath);
    if (!existsSync(fullPath)) throw new Error(`registry path not in repo: ${relPath}`);
    return Promise.resolve(readFileSync(fullPath, 'utf8'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
