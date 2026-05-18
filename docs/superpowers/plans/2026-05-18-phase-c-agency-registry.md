# Phase C — Agency Registry + Schema.org Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a user-pluggable agency registry (YAML data file the user owns) plus the bundled mechanism that reads it: registry loader (file/HTTPS/git), config preprocessor that expands each enabled entry into a synthetic source-plugin instance, the generic `@wabe/source-schemaorg` adapter for JSON-LD bearing agency sites, the `@wabe/agency-fingerprint` HTTP-probe classifier, and the `wabe agencies` CLI surface for probing/validating/inspecting.

**Architecture:** Wabe ships **mechanism**; the user ships **data**. An empty/absent registry yields zero agency sources (graceful no-op). Each enabled registry row becomes a synthetic source plugin instance keyed `agency:<platform>:<id>`; the existing plugin loader runs unchanged on the expanded `sources[]`. The generic JSON-LD adapter is the workhorse — family-specific adapters (ImmoMig, Casasoft) stay deferred until the discovery spike (post-merge `wabe agencies probe-portal flatfox --top=500`) shows they would cover ≥15% share.

**Tech Stack:** TypeScript, Zod, undici, fast-xml-parser, @noble/ed25519 (signature verify), simple-git (registry pull), Vitest. Spec reference: `docs/superpowers/specs/2026-05-18-multi-source-expansion-design.md` §6 (revised scope).

**Sequencing:** All tasks share `@wabe/core` + `@wabe/server` schema/loader changes upfront and can run mostly sequentially in a single worktree. Two leaf packages (`@wabe/source-schemaorg`, `@wabe/agency-fingerprint`) are independent and could go to parallel worktrees if desired.

---

## File map

### New files

| Path | Purpose |
|------|---------|
| `packages/core/src/schemas/agency-registry.ts` | `AgencyEntry` + `AgencyRegistry` Zod schemas |
| `packages/core/test/agency-registry.test.ts` | Schema validation tests |
| `packages/server/src/agency-registry/loader.ts` | Resolve file / HTTPS / git registry sources |
| `packages/server/src/agency-registry/verify.ts` | Optional Ed25519 signature verification |
| `packages/server/src/agency-registry/expand.ts` | Preprocessor: registry rows → synthetic `sources[]` entries |
| `packages/server/test/agency-registry-expand.test.ts` | Preprocessor unit tests |
| `packages/server/test/agency-registry-loader.test.ts` | Loader unit tests (file path; HTTPS via undici MockAgent) |
| `packages/agency-fingerprint/` | `@wabe/agency-fingerprint` package — HTTP probe + classifier |
| `packages/agency-fingerprint/src/index.ts` | `fingerprint(url, signal)` public API |
| `packages/agency-fingerprint/src/heuristics.ts` | Per-family signature checks |
| `packages/agency-fingerprint/test/fingerprint.test.ts` | Test against captured HTML samples |
| `packages/agency-fingerprint/test/fixtures/*.html` | Captured anonymised HTML samples for each known family |
| `packages/agency-fingerprint/package.json` + `tsconfig.json` + `README.md` | Package boilerplate |
| `plugins/source-schemaorg/` | `@wabe/source-schemaorg` generic plugin |
| `plugins/source-schemaorg/src/index.ts` | Source export + ConfigSchema |
| `plugins/source-schemaorg/src/sitemap.ts` | Sitemap-driven discovery (reuses immobilier pattern) |
| `plugins/source-schemaorg/src/detail.ts` | JSON-LD extractor (lifted from `plugins/source-immobilier-ch/src/detail.ts`) |
| `plugins/source-schemaorg/src/map.ts` | `RealEstateListing` + `Residence` + `Product` → `RawListing` mapping |
| `plugins/source-schemaorg/test/*.test.ts` | Inline-fixture tests |
| `plugins/source-schemaorg/package.json` + `tsconfig.json` + `README.md` | Package boilerplate |
| `packages/cli/src/commands/agencies/index.ts` | `wabe agencies` parent command |
| `packages/cli/src/commands/agencies/probe.ts` | `wabe agencies probe <url>` |
| `packages/cli/src/commands/agencies/probe-portal.ts` | `wabe agencies probe-portal <portal>` |
| `packages/cli/src/commands/agencies/validate.ts` | `wabe agencies validate <file>` |
| `packages/cli/src/commands/agencies/stats.ts` | `wabe agencies stats` |
| `examples/zurich-family/config/agencies.example.yaml` | Hand-crafted 3-entry example registry |
| `examples/zurich-family/config/plugins/agencies.yaml` | Wires the example registry into the example config |

### Modified files

| Path | Change |
|------|--------|
| `packages/core/src/index.ts` | Re-export `AgencyEntry` + `AgencyRegistry` |
| `packages/core/src/canonical-key.ts` | Add `'source-schemaorg': 70` and `'agency': 100` to `SOURCE_PRIORITY_DEFAULTS` (last one is already there per Phase A — verify) |
| `packages/server/src/config.ts` | Call `expandAgencyRegistry(top, configDir)` between Zod parse and return; merge expanded entries into `top.enabled.sources` |
| `packages/server/package.json` | Add `@wabe/source-schemaorg`, `@wabe/agency-fingerprint` as dependencies; add `@noble/ed25519` runtime dep for signature verify |
| `packages/cli/src/index.ts` | Register `wabe agencies` parent command |
| `packages/cli/package.json` | Add `@wabe/agency-fingerprint`, `@wabe/source-schemaorg` deps for CLI to use the probe + validate logic |
| `examples/zurich-family/config/config.yaml` | Enable the `agencies` meta-source |

---

## Tasks

### Task 1: `AgencyRegistry` Zod schema in `@wabe/core`

**Files:**
- Create: `packages/core/src/schemas/agency-registry.ts`
- Create: `packages/core/test/agency-registry.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/agency-registry.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { AgencyEntry, AgencyRegistry } from '../src/schemas/agency-registry.js';

describe('AgencyEntry', () => {
  it('accepts a minimum-viable entry with defaults', () => {
    const parsed = AgencyEntry.parse({
      id: 'walde',
      name: 'Walde Immobilien',
      website: 'https://walde.ch',
      canton: 'ZH',
      platform: 'schemaorg',
    });
    expect(parsed.enabled).toBe(true);
    expect(parsed.priority).toBe(100);
    expect(parsed.rate_limit_per_min).toBe(6);
  });
  it('rejects non-kebab id', () => {
    expect(() =>
      AgencyEntry.parse({ id: 'Walde Immo', name: 'x', website: 'https://x.ch', canton: 'ZH', platform: 'schemaorg' }),
    ).toThrow();
  });
  it('rejects unknown canton', () => {
    expect(() =>
      AgencyEntry.parse({ id: 'x', name: 'x', website: 'https://x.ch', canton: 'XX', platform: 'schemaorg' }),
    ).toThrow();
  });
  it('rejects unknown platform', () => {
    expect(() =>
      AgencyEntry.parse({ id: 'x', name: 'x', website: 'https://x.ch', canton: 'ZH', platform: 'bogus' }),
    ).toThrow();
  });
});

describe('AgencyRegistry', () => {
  it('parses a minimal registry', () => {
    const r = AgencyRegistry.parse({
      version: 1,
      source: 'marco-private-2026q2',
      agencies: [
        { id: 'walde', name: 'Walde Immobilien', website: 'https://walde.ch', canton: 'ZH', platform: 'schemaorg' },
      ],
    });
    expect(r.agencies).toHaveLength(1);
    expect(r.agencies[0]?.id).toBe('walde');
  });
  it('rejects wrong version', () => {
    expect(() =>
      AgencyRegistry.parse({ version: 2, source: 'x', agencies: [] }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test, observe failure**

```
pnpm --filter @wabe/core test agency-registry
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement schema**

Create `packages/core/src/schemas/agency-registry.ts`:

```typescript
import { z } from 'zod';

const CANTONS = [
  'ZH', 'BE', 'LU', 'UR', 'SZ', 'OW', 'NW', 'GL', 'ZG', 'FR', 'SO', 'BS', 'BL',
  'SH', 'AR', 'AI', 'SG', 'GR', 'AG', 'TG', 'TI', 'VD', 'VS', 'NE', 'GE', 'JU',
] as const;

export const AgencyEntry = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, 'id must be kebab-case ([a-z0-9-]+)'),
  name: z.string().min(1),
  website: z.string().url(),
  canton: z.enum(CANTONS),
  platform: z.enum(['immomig', 'casasoft', 'schemaorg', 'custom']),
  feed_url: z.string().url().optional(),
  detail_url_template: z.string().optional(),
  rate_limit_per_min: z.number().int().positive().default(6),
  priority: z.number().int().min(0).max(100).default(100),
  enabled: z.boolean().default(true),
  notes: z.string().optional(),
});
export type AgencyEntry = z.infer<typeof AgencyEntry>;

export const AgencyRegistry = z.object({
  version: z.literal(1),
  source: z.string().min(1),
  fetched_at: z.string().datetime().optional(),
  agencies: z.array(AgencyEntry),
});
export type AgencyRegistry = z.infer<typeof AgencyRegistry>;
```

- [ ] **Step 4: Re-export from `index.ts`**

Append to `packages/core/src/index.ts`:

```typescript
export { AgencyEntry, AgencyRegistry } from './schemas/agency-registry.js';
```

- [ ] **Step 5: Run tests, observe pass**

```
pnpm --filter @wabe/core test agency-registry
```
Expected: 6 tests pass.

- [ ] **Step 6: Commit**

```
git add packages/core/src/schemas/agency-registry.ts packages/core/src/index.ts packages/core/test/agency-registry.test.ts
git commit -S -m "feat(core): AgencyEntry + AgencyRegistry Zod schemas"
```

---

### Task 2: Source priority defaults — add `agency` and `source-schemaorg`

**Files:**
- Modify: `packages/core/src/canonical-key.ts`

Phase A's defaults already include `agency: 100`. This task ensures the schemaorg generic plugin gets the right default and verifies the agency rank.

- [ ] **Step 1: Verify + add `source-schemaorg`**

Open `packages/core/src/canonical-key.ts`. Locate `SOURCE_PRIORITY_DEFAULTS`. Confirm `agency: 100` exists. Add:

```typescript
  'source-schemaorg': 70,
```

inside the object literal next to the other portal-tier defaults.

- [ ] **Step 2: Add a test**

Append to `packages/core/test/canonical-key.test.ts` inside the existing `describe('SOURCE_PRIORITY_DEFAULTS')`:

```typescript
  it('source-schemaorg lands in portal tier (70)', () => {
    expect(SOURCE_PRIORITY_DEFAULTS['source-schemaorg']).toBe(70);
  });
```

- [ ] **Step 3: Run tests**

```
pnpm --filter @wabe/core test canonical-key
```
Expected: existing tests + new one pass.

- [ ] **Step 4: Commit**

```
git add packages/core/src/canonical-key.ts packages/core/test/canonical-key.test.ts
git commit -S -m "feat(core): source-schemaorg portal-tier priority default"
```

---

### Task 3: Registry loader (file + HTTPS + git)

**Files:**
- Create: `packages/server/src/agency-registry/loader.ts`
- Create: `packages/server/test/agency-registry-loader.test.ts`
- Modify: `packages/server/package.json` (add `simple-git` if you want git pull; or shell out via `child_process` — pick one in Step 1)

- [ ] **Step 1: Pick git impl**

For minimal deps and predictable behaviour, shell out via `child_process.execFile('git', [...])`. This avoids adding `simple-git` as a runtime dep. The loader will refuse a `git+` URL when `git` is not on PATH.

- [ ] **Step 2: Write the failing test**

Create `packages/server/test/agency-registry-loader.test.ts`:

```typescript
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import { loadRegistry } from '../src/agency-registry/loader.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wabe-reg-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const YAML = `version: 1
source: test
agencies:
  - id: walde
    name: Walde
    website: https://walde.ch
    canton: ZH
    platform: schemaorg
`;

describe('loadRegistry — file', () => {
  it('reads a local yaml file and parses it', async () => {
    const path = join(dir, 'agencies.yaml');
    writeFileSync(path, YAML, 'utf8');
    const r = await loadRegistry({ registry: path, configDir: dir, signal: new AbortController().signal });
    expect(r.agencies).toHaveLength(1);
    expect(r.agencies[0]?.id).toBe('walde');
  });
});

describe('loadRegistry — HTTPS', () => {
  let agent: MockAgent;
  let prev: ReturnType<typeof getGlobalDispatcher>;
  beforeEach(() => {
    prev = getGlobalDispatcher();
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });
  afterEach(async () => {
    await agent.close();
    setGlobalDispatcher(prev);
  });

  it('fetches over HTTPS and parses', async () => {
    agent
      .get('https://example.com')
      .intercept({ method: 'GET', path: '/agencies.yaml' })
      .reply(200, YAML, { headers: { 'content-type': 'text/yaml' } });
    const r = await loadRegistry({
      registry: 'https://example.com/agencies.yaml',
      configDir: dir,
      signal: new AbortController().signal,
    });
    expect(r.agencies).toHaveLength(1);
  });

  it('sends bearer auth when registry_auth provided', async () => {
    agent
      .get('https://example.com')
      .intercept({ method: 'GET', path: '/agencies.yaml', headers: { authorization: 'Bearer SECRET' } })
      .reply(200, YAML, { headers: { 'content-type': 'text/yaml' } });
    const r = await loadRegistry({
      registry: 'https://example.com/agencies.yaml',
      registry_auth: 'SECRET',
      configDir: dir,
      signal: new AbortController().signal,
    });
    expect(r.agencies).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run test, observe failure**

```
pnpm --filter @wabe/server test agency-registry-loader
```
Expected: FAIL — module not found.

- [ ] **Step 4: Implement loader**

Create `packages/server/src/agency-registry/loader.ts`:

```typescript
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
```

- [ ] **Step 5: Run tests, observe pass**

```
pnpm --filter @wabe/server test agency-registry-loader
```
Expected: 3 tests pass.

- [ ] **Step 6: Commit**

```
git add packages/server/src/agency-registry/loader.ts packages/server/test/agency-registry-loader.test.ts
git commit -S -m "feat(server): agency-registry loader — file/HTTPS/git+bearer auth"
```

---

### Task 4: Optional Ed25519 signature verification

**Files:**
- Modify: `packages/server/package.json` (add `@noble/ed25519`)
- Create: `packages/server/src/agency-registry/verify.ts`
- Create: `packages/server/test/agency-registry-verify.test.ts`

`@noble/ed25519` is a small, zero-dependency Ed25519 implementation. Add it as a runtime dep.

- [ ] **Step 1: Add dep**

In `packages/server/package.json` `dependencies`, add:

```json
    "@noble/ed25519": "^2.1.0",
```

Run `pnpm install`.

- [ ] **Step 2: Write failing test**

Create `packages/server/test/agency-registry-verify.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { verifySignature } from '../src/agency-registry/verify.js';

// Node's built-in crypto generates Ed25519 keypairs — we use it for the test
// rather than importing @noble/ed25519 here, so we exercise our verifier
// against a known-good external implementation.
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pubHex = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');

describe('verifySignature', () => {
  it('returns true for a valid Ed25519 signature over the payload', async () => {
    const payload = 'version: 1\nsource: test\nagencies: []\n';
    const sig = sign(null, Buffer.from(payload), privateKey).toString('hex');
    await expect(verifySignature(payload, sig, pubHex)).resolves.toBe(true);
  });
  it('returns false when payload is mutated', async () => {
    const payload = 'version: 1\nsource: test\nagencies: []\n';
    const sig = sign(null, Buffer.from(payload), privateKey).toString('hex');
    await expect(verifySignature(payload + 'tampered', sig, pubHex)).resolves.toBe(false);
  });
});
```

- [ ] **Step 3: Run test, observe failure**

```
pnpm --filter @wabe/server test agency-registry-verify
```
Expected: FAIL — module not found.

- [ ] **Step 4: Implement verifier**

Create `packages/server/src/agency-registry/verify.ts`:

```typescript
import * as ed from '@noble/ed25519';

/**
 * Verifies an Ed25519 signature over a UTF-8 payload.
 *
 * @param payload  The exact UTF-8 string that was signed.
 * @param sigHex   Hex-encoded 64-byte Ed25519 signature.
 * @param pubKeyHex Hex-encoded 32-byte Ed25519 public key.
 * @returns true if the signature is valid, false otherwise (incl. malformed inputs).
 */
export async function verifySignature(payload: string, sigHex: string, pubKeyHex: string): Promise<boolean> {
  try {
    const sig = hexToBytes(sigHex);
    const pub = hexToBytes(pubKeyHex);
    const msg = new TextEncoder().encode(payload);
    return await ed.verifyAsync(sig, msg, pub);
  } catch {
    return false;
  }
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('odd hex length');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error('bad hex');
    out[i] = byte;
  }
  return out;
}
```

- [ ] **Step 5: Run tests, observe pass**

```
pnpm --filter @wabe/server test agency-registry-verify
```
Expected: 2 tests pass.

- [ ] **Step 6: Commit**

```
git add packages/server/package.json pnpm-lock.yaml packages/server/src/agency-registry/verify.ts packages/server/test/agency-registry-verify.test.ts
git commit -S -m "feat(server): optional Ed25519 signature verify for agency registry"
```

---

### Task 5: Config preprocessor — expand registry into synthetic source entries

**Files:**
- Create: `packages/server/src/agency-registry/expand.ts`
- Create: `packages/server/test/agency-registry-expand.test.ts`
- Modify: `packages/server/src/config.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/server/test/agency-registry-expand.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { AgencyRegistry } from '@wabe/core';
import { expandRegistry } from '../src/agency-registry/expand.js';

const reg: AgencyRegistry = AgencyRegistry.parse({
  version: 1,
  source: 'test',
  agencies: [
    { id: 'walde', name: 'Walde', website: 'https://walde.ch', canton: 'ZH', platform: 'schemaorg' },
    { id: 'nobilis', name: 'Nobilis', website: 'https://nobilis.ch', canton: 'ZH', platform: 'casasoft', enabled: false },
    { id: 'unknown-fam', name: 'X', website: 'https://x.ch', canton: 'ZH', platform: 'immomig' },
  ],
});

const BUNDLED = new Set(['source-schemaorg']);

describe('expandRegistry', () => {
  it('emits one synthetic entry per enabled row whose platform has a bundled adapter', () => {
    const result = expandRegistry(reg, BUNDLED);
    expect(result.expanded).toHaveLength(1);
    expect(result.expanded[0]?.name).toBe('agency:schemaorg:walde');
    expect(result.expanded[0]?.plugin).toBe('source-schemaorg');
  });
  it('skips disabled rows', () => {
    const r = expandRegistry(reg, BUNDLED);
    expect(r.expanded.some((e) => e.name.includes('nobilis'))).toBe(false);
  });
  it('reports unknown-platform rows in `skipped` (never throws)', () => {
    const r = expandRegistry(reg, BUNDLED);
    expect(r.skipped.find((s) => s.id === 'unknown-fam')?.reason).toMatch(/no bundled adapter/);
  });
  it('returns empty arrays for empty registry', () => {
    const r = expandRegistry(AgencyRegistry.parse({ version: 1, source: 'x', agencies: [] }), BUNDLED);
    expect(r.expanded).toEqual([]);
    expect(r.skipped).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test, observe failure**

```
pnpm --filter @wabe/server test agency-registry-expand
```
Expected: FAIL.

- [ ] **Step 3: Implement preprocessor**

Create `packages/server/src/agency-registry/expand.ts`:

```typescript
import type { AgencyEntry, AgencyRegistry } from '@wabe/core';

export interface ExpandedSource {
  /** Synthetic name for the loaded plugin instance (also drives logging + breaker keys). */
  name: string;
  /** Bundled adapter package name (resolves through normal plugin loader). */
  plugin: string;
  /**
   * Inline config object (no file path — the loader supports both forms via
   * `EnabledEntry.config` being either a YAML path or, when prefixed with
   * `inline:`, a base64-encoded JSON blob; expandRegistry uses inline mode).
   */
  config: string;
}

export interface SkippedAgency {
  id: string;
  platform: AgencyEntry['platform'];
  reason: string;
}

export interface ExpandResult {
  expanded: ExpandedSource[];
  skipped: SkippedAgency[];
}

/** Map an agency `platform` value to the bundled adapter's npm name. */
function adapterFor(platform: AgencyEntry['platform']): string | null {
  switch (platform) {
    case 'schemaorg':
      return 'source-schemaorg';
    case 'immomig':
    case 'casasoft':
    case 'custom':
      return null;
  }
}

/**
 * Expands enabled agency rows into synthetic source-plugin entries that the
 * regular plugin loader can resolve. Rows referencing a platform whose adapter
 * isn't bundled in the current Wabe build go into `skipped` (never throws),
 * keeping registries forward-compatible with future bundled adapters.
 */
export function expandRegistry(reg: AgencyRegistry, bundledAdapterNames: Set<string>): ExpandResult {
  const expanded: ExpandedSource[] = [];
  const skipped: SkippedAgency[] = [];
  for (const a of reg.agencies) {
    if (!a.enabled) continue;
    const adapter = adapterFor(a.platform);
    if (adapter === null || !bundledAdapterNames.has(adapter)) {
      skipped.push({
        id: a.id,
        platform: a.platform,
        reason:
          adapter === null
            ? `platform "${a.platform}" has no bundled adapter`
            : `bundled adapter "${adapter}" not installed`,
      });
      continue;
    }
    // Inline config so the plugin loader doesn't need a YAML path per agency row.
    const inlineConfig: Record<string, unknown> = {
      website: a.website,
      canton: a.canton,
      priority: a.priority,
      rate_limit_per_min: a.rate_limit_per_min,
    };
    if (a.feed_url) inlineConfig.feed_url = a.feed_url;
    if (a.detail_url_template) inlineConfig.detail_url_template = a.detail_url_template;
    expanded.push({
      name: `agency:${a.platform}:${a.id}`,
      plugin: adapter,
      config: `inline:${Buffer.from(JSON.stringify(inlineConfig), 'utf8').toString('base64')}`,
    });
  }
  return { expanded, skipped };
}

/** List of platform→adapter mappings used by `BUNDLED_ADAPTERS`. Re-exported for the CLI. */
export const BUNDLED_ADAPTERS: ReadonlySet<string> = new Set(['source-schemaorg']);
```

- [ ] **Step 4: Wire into `loadConfig`**

In `packages/server/src/config.ts`:

(a) At the top, add imports:

```typescript
import { loadRegistry } from './agency-registry/loader.js';
import { expandRegistry, BUNDLED_ADAPTERS } from './agency-registry/expand.js';
import { verifySignature } from './agency-registry/verify.js';
import { readFileSync, existsSync } from 'node:fs';
```

(b) Extend `loadConfig`'s return so the orchestrator can know about skipped agencies (for logging). Add a new `skippedAgencies` field to `LoadedConfig`:

```typescript
export interface LoadedConfig {
  top: TopConfig;
  filters: z.infer<typeof FiltersFile>;
  scoring: z.infer<typeof ScoringFile>;
  rentalTerm: RentalTermPolicy;
  configDir: string;
  skippedAgencies: Array<{ id: string; platform: string; reason: string }>;
}
```

(c) Detect an `agencies` entry in `top.enabled.sources` (the meta-source); when present, read its config yaml (e.g. `plugins/agencies.yaml`) which holds `{ registry, registry_auth?, signature_pubkey? }`; load + verify + expand; replace the `agencies` meta-entry with the expanded entries; merge `skipped` into the return.

Add this transformation at the end of `loadConfig` before `return`:

```typescript
  const expanded = await expandAgenciesIfPresent(top, configDir);
  if (expanded) {
    top.enabled.sources = top.enabled.sources
      .filter((s) => s.plugin !== 'agencies')
      .concat(expanded.expandedSources);
  }
  return { top, filters, scoring, rentalTerm, configDir, skippedAgencies: expanded?.skipped ?? [] };
```

And convert `loadConfig` to `async function loadConfig(...): Promise<LoadedConfig>` (callers need updating accordingly — search `loadConfig(` and `await` it).

Add the helper at the bottom of `config.ts`:

```typescript
async function expandAgenciesIfPresent(
  top: TopConfig,
  configDir: string,
): Promise<{ expandedSources: EnabledEntry[]; skipped: Array<{ id: string; platform: string; reason: string }> } | null> {
  const meta = top.enabled.sources.find((s) => s.plugin === 'agencies');
  if (!meta) return null;
  const metaCfgPath = join(configDir, meta.config);
  if (!existsSync(metaCfgPath)) throw new Error(`agencies meta config not found: ${metaCfgPath}`);
  const raw = loadYaml<{
    registry: string;
    registry_auth?: string;
    signature_pubkey?: string;
  }>(metaCfgPath);
  const ac = new AbortController();
  const registry = await loadRegistry({
    registry: raw.registry,
    registry_auth: raw.registry_auth,
    configDir,
    signal: ac.signal,
  });
  if (raw.signature_pubkey) {
    const sigPath = `${raw.registry}.sig`;
    if (existsSync(sigPath)) {
      const sig = readFileSync(sigPath, 'utf8').trim();
      const payload = readFileSync(raw.registry, 'utf8');
      const ok = await verifySignature(payload, sig, raw.signature_pubkey);
      if (!ok) throw new Error(`agency-registry signature verification failed`);
    }
  }
  const { expanded, skipped } = expandRegistry(registry, BUNDLED_ADAPTERS as Set<string>);
  return {
    expandedSources: expanded.map((e) => ({ name: e.name, plugin: e.plugin, config: e.config })),
    skipped,
  };
}
```

NOTE: the existing plugin loader (`packages/server/src/loader.ts` → `loadPluginConfig`) reads a YAML file from the `config` field. To accept inline configs, extend `loadPluginConfig` in this task too — if `relPath.startsWith('inline:')`, decode the base64 JSON and validate directly:

In `packages/server/src/config.ts`, modify `loadPluginConfig`:

```typescript
export function loadPluginConfig<T extends z.ZodTypeAny>(
  configDir: string,
  relPath: string,
  schema: T,
): z.infer<T> {
  if (relPath.startsWith('inline:')) {
    const b64 = relPath.slice('inline:'.length);
    const obj = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as unknown;
    const interpolated = interpolateEnv(obj);
    return schema.parse(interpolated);
  }
  const full = join(configDir, relPath);
  const raw = loadYaml<unknown>(full);
  const interpolated = interpolateEnv(raw);
  return schema.parse(interpolated);
}
```

- [ ] **Step 5: Update callers of `loadConfig` to await it**

Search for `loadConfig(` across `packages/cli/` and `packages/server/`. Each call must become `await loadConfig(...)`. Most call sites are CLI commands inside `Command.action(async () => {...})` so they're already in async contexts.

- [ ] **Step 6: Run tests**

```
pnpm --filter @wabe/server test agency-registry-expand
pnpm --filter @wabe/server test
pnpm --filter @wabe/cli test
```
Expected: PASS (the wider test sweep catches caller-await regressions).

- [ ] **Step 7: Commit**

```
git add packages/server/src/agency-registry/expand.ts packages/server/src/config.ts packages/server/test/agency-registry-expand.test.ts packages/cli/src/
git commit -S -m "feat(server): config preprocessor expands agency registry into source-plugin entries"
```

---

### Task 6: Scaffold `@wabe/agency-fingerprint` package

**Files:**
- Create: `packages/agency-fingerprint/package.json`
- Create: `packages/agency-fingerprint/tsconfig.json`
- Create: `packages/agency-fingerprint/README.md`
- Create: `packages/agency-fingerprint/src/index.ts` (stub)

- [ ] **Step 1: `package.json`**

```json
{
  "name": "@wabe/agency-fingerprint",
  "version": "0.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": "./dist/index.js" },
  "license": "AGPL-3.0-or-later",
  "scripts": {
    "build": "tsc -b",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "undici": "^6.19.8"
  },
  "devDependencies": {
    "@types/node": "^22.7.4",
    "typescript": "^5.6.2",
    "vitest": "^2.1.1"
  }
}
```

- [ ] **Step 2: `tsconfig.json`** — copy from `plugins/source-flatfox/tsconfig.json`.

- [ ] **Step 3: Stub `src/index.ts` and `README.md`** as one-liners; will be replaced in Task 7.

- [ ] **Step 4: Install + typecheck**

```
pnpm install
pnpm --filter @wabe/agency-fingerprint typecheck
```
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add packages/agency-fingerprint/
git commit -S -m "chore(agency-fingerprint): scaffold package"
```

---

### Task 7: `agency-fingerprint` — heuristics + classifier

**Files:**
- Create: `packages/agency-fingerprint/src/heuristics.ts`
- Create: `packages/agency-fingerprint/src/index.ts` (overwrite stub)
- Create: `packages/agency-fingerprint/test/heuristics.test.ts`
- Modify: `packages/agency-fingerprint/README.md`

The signature catalog below is the **starting heuristic** per the spec — candidates pending validation by the discovery spike. The implementation must be easy to extend (add a new entry to the catalog) without touching the classifier core.

- [ ] **Step 1: Heuristics catalog (`heuristics.ts`)**

Create `packages/agency-fingerprint/src/heuristics.ts`:

```typescript
export type Platform = 'immomig' | 'casasoft' | 'schemaorg' | 'iframe-portal' | 'custom';

export interface Heuristic {
  platform: Platform;
  test: (input: HeuristicInput) => boolean;
}

export interface HeuristicInput {
  html: string;
  url: string;
  headers: Record<string, string>;
}

/** Catalog scanned in order; first match wins. `custom` is the implicit fallback. */
export const HEURISTICS: Heuristic[] = [
  {
    platform: 'immomig',
    test: ({ html }) =>
      /<meta\s+name=["']generator["']\s+content=["'][^"']*ImmoMig/i.test(html) || /\/ig\.fcgi/i.test(html),
  },
  {
    platform: 'casasoft',
    test: ({ html }) => /casasoft\.ch/i.test(html) || /\/api\/PropertySearch/i.test(html),
  },
  {
    platform: 'iframe-portal',
    test: ({ html }) =>
      /<iframe[^>]+src=["'][^"']*(?:homegate|immoscout24)\.ch/i.test(html),
  },
  {
    platform: 'schemaorg',
    test: ({ html }) =>
      /<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?@type["']?\s*:\s*["']RealEstateListing["']/i.test(
        html,
      ),
  },
];
```

- [ ] **Step 2: Classifier (`index.ts`)**

Overwrite `packages/agency-fingerprint/src/index.ts`:

```typescript
import { request } from 'undici';
import { HEURISTICS, type Platform, type HeuristicInput } from './heuristics.js';

export interface FingerprintResult {
  platform: Platform;
  /** Probed URL (post-redirect canonical). */
  url: string;
  /** Probed HTTP status. */
  status: number;
  /** Free-form note that explains *why* this platform was chosen (debug aid). */
  reason: string;
}

/**
 * Fetches a single HTML page and classifies its underlying platform.
 *
 * Returns `custom` when no heuristic matches — caller decides what to do
 * (typically: skip the agency until a family adapter exists, or rely on the
 * schema.org adapter if some JSON-LD is present but doesn't match its
 * narrower regex).
 */
export async function fingerprint(url: string, signal: AbortSignal): Promise<FingerprintResult> {
  const res = await request(url, {
    method: 'GET',
    signal,
    headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 wabe-fingerprint/0' },
  });
  const html = await res.body.text();
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers)) headers[k] = Array.isArray(v) ? v.join(',') : String(v ?? '');
  const input: HeuristicInput = { html, url, headers };
  for (const h of HEURISTICS) {
    if (h.test(input)) return { platform: h.platform, url, status: res.statusCode, reason: `matched heuristic: ${h.platform}` };
  }
  return { platform: 'custom', url, status: res.statusCode, reason: 'no heuristic matched' };
}

export { type Platform } from './heuristics.js';
```

- [ ] **Step 3: Tests**

Create `packages/agency-fingerprint/test/heuristics.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { HEURISTICS } from '../src/heuristics.js';

const samples: Record<string, string> = {
  immomig: `<html><head><meta name="generator" content="ImmoMig 5.4"></head></html>`,
  casasoft: `<html><body><script src="https://casasoft.ch/widget.js"></script></body></html>`,
  iframePortal: `<html><body><iframe src="https://homegate.ch/embed/123"></iframe></body></html>`,
  schemaorg: `<html><head><script type="application/ld+json">{"@type":"RealEstateListing","name":"x"}</script></head></html>`,
  empty: `<html><body>nothing useful here</body></html>`,
};

function match(html: string) {
  for (const h of HEURISTICS) {
    if (h.test({ html, url: 'https://x', headers: {} })) return h.platform;
  }
  return 'custom' as const;
}

describe('HEURISTICS catalog', () => {
  it('classifies immomig generator meta', () => expect(match(samples.immomig!)).toBe('immomig'));
  it('classifies casasoft widget reference', () => expect(match(samples.casasoft!)).toBe('casasoft'));
  it('classifies iframe to a portal as iframe-portal', () => expect(match(samples.iframePortal!)).toBe('iframe-portal'));
  it('classifies pure schema.org JSON-LD as schemaorg', () => expect(match(samples.schemaorg!)).toBe('schemaorg'));
  it('falls through to custom when nothing matches', () => expect(match(samples.empty!)).toBe('custom'));
});
```

- [ ] **Step 4: Run tests, observe pass**

```
pnpm --filter @wabe/agency-fingerprint test
```
Expected: 5 tests pass.

- [ ] **Step 5: README**

Overwrite `packages/agency-fingerprint/README.md`:

```markdown
# @wabe/agency-fingerprint

HTTP-probe-based classifier that tags a Swiss agency URL with the underlying CMS / hosting platform (immomig / casasoft / iframe-portal / schemaorg / custom).

Used by `wabe agencies probe` and `wabe agencies probe-portal` to bootstrap an agency registry without manual classification per entry.

## API

```ts
import { fingerprint } from '@wabe/agency-fingerprint';

const result = await fingerprint('https://walde.ch', new AbortController().signal);
// → { platform: 'schemaorg', url: '...', status: 200, reason: '...' }
```

## Heuristics

The signature catalog (in `src/heuristics.ts`) is intentionally minimal — these are starting candidates that will be validated against real samples during the discovery spike. Add new entries by appending to the `HEURISTICS` array; order matters (first match wins).

Currently recognised:
- **immomig** — generator meta tag or `/ig.fcgi` URL pattern
- **casasoft** — `casasoft.ch` references or `/api/PropertySearch` endpoint
- **iframe-portal** — `<iframe>` from `homegate.ch` or `immoscout24.ch` (skip — no own inventory)
- **schemaorg** — embedded `application/ld+json` block with `@type: RealEstateListing`
- **custom** — fallback when nothing matches; caller decides what to do
```

- [ ] **Step 6: Commit**

```
git add packages/agency-fingerprint/
git commit -S -m "feat(agency-fingerprint): heuristic-based platform classifier"
```

---

### Task 8: Scaffold `@wabe/source-schemaorg` plugin

**Files:**
- Create: `plugins/source-schemaorg/package.json`
- Create: `plugins/source-schemaorg/tsconfig.json`
- Create: `plugins/source-schemaorg/README.md` (stub)
- Create: `plugins/source-schemaorg/src/index.ts` (stub)

Mirror `plugins/source-immobilier-ch/` for layout/toolchain.

- [ ] **Step 1: `package.json`**

```json
{
  "name": "@wabe/source-schemaorg",
  "version": "0.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": "./dist/index.js" },
  "license": "AGPL-3.0-or-later",
  "scripts": {
    "build": "tsc -b",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@wabe/core": "workspace:*",
    "@wabe/plugin-sdk": "workspace:*",
    "fast-xml-parser": "^4.5.0",
    "pino": "^9.4.0",
    "undici": "^6.19.8",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^22.7.4",
    "typescript": "^5.6.2",
    "vitest": "^2.1.1"
  }
}
```

- [ ] **Step 2-3: `tsconfig.json`** + stubs.

- [ ] **Step 4: Install + typecheck**

```
pnpm install
pnpm --filter @wabe/source-schemaorg typecheck
```
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add plugins/source-schemaorg/
git commit -S -m "chore(source-schemaorg): scaffold package"
```

---

### Task 9: `source-schemaorg` — sitemap discovery + JSON-LD parser + mapper + source export

**Files:**
- Create: `plugins/source-schemaorg/src/sitemap.ts`
- Create: `plugins/source-schemaorg/src/detail.ts`
- Create: `plugins/source-schemaorg/src/map.ts`
- Create: `plugins/source-schemaorg/src/index.ts` (overwrite stub)
- Create: `plugins/source-schemaorg/test/{detail,map}.test.ts`

The JSON-LD extractor is the same pattern as `plugins/source-immobilier-ch/src/detail.ts` but recognises `RealEstateListing` (not just `Product`/`Residence`). Don't import from `source-immobilier-ch` — it's a sibling plugin; copy the function bodies to keep packages self-contained.

- [ ] **Step 1: Sitemap (`sitemap.ts`)** — copy + adapt from `plugins/source-immobilier-ch/src/sitemap.ts`:

```typescript
import { request } from 'undici';
import { XMLParser } from 'fast-xml-parser';

export interface DetailUrl {
  loc: string;
  lastmod: string | null;
}

const xml = new XMLParser({ ignoreAttributes: false });

export async function fetchSitemap(url: string, signal: AbortSignal): Promise<DetailUrl[]> {
  const res = await request(url, { signal, method: 'GET', headers: { 'user-agent': 'Mozilla/5.0 wabe/0' } });
  if (res.statusCode !== 200) throw new Error(`sitemap ${url} responded ${res.statusCode}`);
  return parseUrlset(await res.body.text());
}

export function parseUrlset(xmlText: string): DetailUrl[] {
  const parsed = xml.parse(xmlText) as { urlset?: { url?: unknown } };
  const urls = parsed.urlset?.url;
  const list = Array.isArray(urls) ? urls : urls ? [urls] : [];
  return list.map((u) => {
    const node = u as { loc?: string; lastmod?: string };
    return { loc: String(node.loc ?? ''), lastmod: node.lastmod ?? null };
  });
}
```

- [ ] **Step 2: Detail + JSON-LD extractor (`detail.ts`)** — recognise `RealEstateListing`:

```typescript
import { request } from 'undici';

export interface JsonLdListing {
  '@type': 'RealEstateListing' | 'Apartment' | 'House' | 'Residence' | 'Product';
  name?: string;
  description?: string;
  url?: string;
  image?: string | string[];
  numberOfRooms?: number | string;
  floorSize?: { value?: number | string };
  address?: { streetAddress?: string; postalCode?: string; addressLocality?: string; addressRegion?: string };
  offers?: { price?: number | string; priceCurrency?: string };
  datePosted?: string;
}

export interface DetailPayload {
  listing: JsonLdListing | null;
}

export async function fetchDetail(url: string, signal: AbortSignal): Promise<DetailPayload> {
  const res = await request(url, {
    signal,
    method: 'GET',
    headers: { 'user-agent': 'Mozilla/5.0 wabe/0', accept: 'text/html' },
  });
  if (res.statusCode !== 200) throw new Error(`detail ${url} responded ${res.statusCode}`);
  return extractJsonLd(await res.body.text());
}

const TARGET_TYPES = new Set(['RealEstateListing', 'Apartment', 'House', 'Residence']);

export function extractJsonLd(html: string): DetailPayload {
  const out: DetailPayload = { listing: null };
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    const block = m[1];
    if (!block) continue;
    try {
      const obj = JSON.parse(block) as unknown;
      collect(obj, out);
    } catch {
      // ignore malformed blocks
    }
    if (out.listing) break; // first hit wins
  }
  return out;
}

function collect(obj: unknown, out: DetailPayload): void {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (const item of obj) collect(item, out);
    return;
  }
  const type = (obj as { '@type'?: string })['@type'];
  if (type && TARGET_TYPES.has(type)) out.listing = obj as JsonLdListing;
  for (const v of Object.values(obj as Record<string, unknown>)) collect(v, out);
}
```

- [ ] **Step 3: Mapper (`map.ts`)**

```typescript
import type { RawListing } from '@wabe/core';
import type { DetailPayload } from './detail.js';

function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function mapDetail(agencyId: string, url: string, payload: DetailPayload): RawListing | null {
  const l = payload.listing;
  if (!l) return null;
  const idMatch = url.match(/-(\d+)(?:\?|$)/) ?? url.match(/\/(\d+)(?:\?|\/?$)/);
  const idPart = idMatch ? idMatch[1] : url;
  return {
    id: `agency:${agencyId}:${idPart}`,
    source: `agency:schemaorg:${agencyId}`,
    url,
    price: {
      rent_net: null,
      extras: null,
      total: toNum(l.offers?.price),
      currency: l.offers?.priceCurrency ?? 'CHF',
      deposit_months: null,
    },
    rooms: toNum(l.numberOfRooms),
    area_m2: toNum(l.floorSize?.value),
    floor: null,
    total_floors: null,
    built_year: null,
    renovated_year: null,
    location: {
      coords: null,
      address: l.address?.streetAddress ?? null,
      postal_code: l.address?.postalCode ?? null,
      city: l.address?.addressLocality ?? null,
      region: l.address?.addressRegion ?? null,
      country: 'CH',
      neighborhood: null,
    },
    features: {},
    description: l.description ?? null,
    photos: Array.isArray(l.image) ? l.image : l.image ? [l.image] : [],
    available_from: null,
    lease_until: null,
    rental_term: 'unknown',
    agency: agencyId,
    contact: {},
    enriched: {},
    extra: {},
  };
}
```

- [ ] **Step 4: Source export (`index.ts`)**

```typescript
import { z } from 'zod';
import type { PluginExport, Source, Context } from '@wabe/plugin-sdk';
import { fetchSitemap } from './sitemap.js';
import { fetchDetail } from './detail.js';
import { mapDetail } from './map.js';

const ConfigSchema = z.object({
  website: z.string().url(),
  /** Per-agency canton tag stored back into the listing for filter use. */
  canton: z.string().length(2),
  /** Polite pacing. Honor robots.txt Crawl-delay manually. */
  pace_ms: z.number().int().nonnegative().default(5000),
  max_details_per_scan: z.number().int().positive().default(30),
  /** Sitemap location relative to `website`, e.g. "/sitemap.xml". */
  sitemap_path: z.string().default('/sitemap.xml'),
  /** Optional explicit feed URL that overrides the website + sitemap_path concat. */
  feed_url: z.string().url().optional(),
  rate_limit_per_min: z.number().int().positive().default(6),
  priority: z.number().int().min(0).max(100).default(100),
  emit_on_first_scan: z.boolean().default(false),
});
type Config = z.infer<typeof ConfigSchema>;

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    });
  });
}

function agencyIdFromName(name: string): string {
  const m = name.match(/^agency:[a-z0-9-]+:([a-z0-9-]+)$/);
  return m ? (m[1] ?? name) : name;
}

const plugin: Source = {
  name: 'source-schemaorg',
  configSchema: ConfigSchema,
  async *fetch(ctx: Context) {
    const cfg = ctx.config as Config;
    const agencyId = agencyIdFromName((ctx.config as { __pluginInstanceName?: string }).__pluginInstanceName ?? 'unknown');
    const sitemapUrl = cfg.feed_url ?? new URL(cfg.sitemap_path, cfg.website).toString();
    const entries = await fetchSitemap(sitemapUrl, ctx.signal);
    entries.sort((a, b) => (b.lastmod ?? '').localeCompare(a.lastmod ?? ''));
    let scanned = 0;
    for (const e of entries) {
      if (ctx.signal.aborted) return;
      if (scanned >= cfg.max_details_per_scan) break;
      scanned += 1;
      try {
        const payload = await fetchDetail(e.loc, ctx.signal);
        const mapped = mapDetail(agencyId, e.loc, payload);
        if (mapped) yield mapped;
      } catch (err) {
        ctx.logger.warn({ url: e.loc, err: (err as Error).message }, 'schemaorg detail failed');
      }
      await sleep(cfg.pace_ms, ctx.signal);
    }
  },
};

const exp: PluginExport = { kind: 'source', plugin };
export default exp;
```

NOTE: the `__pluginInstanceName` access above assumes the plugin loader will be extended in Task 10 to inject the instance name into the config. If that's too invasive, take a simpler path: pass `agency_id` as a normal config field set by `expand.ts` when building the inline config (preferred — update Task 5 Step 3's `expand.ts` to set `inlineConfig.agency_id = a.id`).

For this task, assume `agency_id` is a config field. Update `ConfigSchema`:

```typescript
const ConfigSchema = z.object({
  agency_id: z.string().min(1),    // injected by expand.ts from registry row
  website: z.string().url(),
  ...
});
```

And replace the `agencyIdFromName` helper with `const agencyId = cfg.agency_id;`. Also update Task 5 Step 3's `expand.ts` to add `inlineConfig.agency_id = a.id;` before serialising.

- [ ] **Step 5: Tests**

Create `plugins/source-schemaorg/test/detail.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { extractJsonLd } from '../src/detail.js';

describe('extractJsonLd', () => {
  it('picks up @type: RealEstateListing', () => {
    const html = `<script type="application/ld+json">{"@type":"RealEstateListing","numberOfRooms":"3.5","floorSize":{"value":"95"},"offers":{"price":"2400","priceCurrency":"CHF"},"address":{"postalCode":"8008","addressLocality":"Zürich"}}</script>`;
    const out = extractJsonLd(html);
    expect(out.listing?.numberOfRooms).toBe('3.5');
    expect(out.listing?.offers?.price).toBe('2400');
  });
  it('picks up @type: Apartment via nested @graph', () => {
    const html = `<script type="application/ld+json">{"@graph":[{"@type":"Organization","name":"x"},{"@type":"Apartment","numberOfRooms":4}]}</script>`;
    expect(extractJsonLd(html).listing?.['@type']).toBe('Apartment');
  });
  it('returns null when no matching type', () => {
    expect(extractJsonLd('<script type="application/ld+json">{"@type":"Article"}</script>')).toEqual({ listing: null });
  });
});
```

Create `plugins/source-schemaorg/test/map.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { mapDetail } from '../src/map.js';

describe('mapDetail', () => {
  it('maps a full RealEstateListing payload', () => {
    const out = mapDetail('walde', 'https://walde.ch/object-12345', {
      listing: {
        '@type': 'RealEstateListing',
        name: 'Nice flat',
        numberOfRooms: '3.5',
        floorSize: { value: '95' },
        offers: { price: '2400', priceCurrency: 'CHF' },
        address: { streetAddress: 'Bahnhofstr. 1', postalCode: '8008', addressLocality: 'Zürich' },
        image: 'https://walde.ch/i.jpg',
        description: 'A flat',
      },
    });
    expect(out?.id).toBe('agency:walde:12345');
    expect(out?.source).toBe('agency:schemaorg:walde');
    expect(out?.rooms).toBe(3.5);
    expect(out?.area_m2).toBe(95);
    expect(out?.price.total).toBe(2400);
    expect(out?.location.postal_code).toBe('8008');
    expect(out?.agency).toBe('walde');
  });
});
```

- [ ] **Step 6: Run tests**

```
pnpm --filter @wabe/source-schemaorg test
```
Expected: PASS.

- [ ] **Step 7: Commit**

```
git add plugins/source-schemaorg/src/ plugins/source-schemaorg/test/
git commit -S -m "feat(source-schemaorg): sitemap-driven generic JSON-LD scraper"
```

---

### Task 10: `source-schemaorg` README

**Files:**
- Modify: `plugins/source-schemaorg/README.md`

- [ ] **Step 1: README**

Overwrite `plugins/source-schemaorg/README.md`:

```markdown
# @wabe/source-schemaorg

Generic source plugin for agency websites that emit `schema.org/RealEstateListing` (or `Apartment` / `House` / `Residence`) JSON-LD on their detail pages.

This is Wabe's workhorse adapter for the Swiss agency long tail — many CMSes and bespoke sites embed structured data for SEO; this plugin parses it without needing per-agency code.

## When to use

The `@wabe/agency-fingerprint` classifier returns `schemaorg` for a probed agency URL. Add the agency to your `agencies.yaml`:

```yaml
agencies:
  - id: walde
    name: Walde Immobilien
    website: https://walde.ch
    canton: ZH
    platform: schemaorg
```

The config preprocessor expands the row into a `source-schemaorg` plugin instance — no per-agency YAML needed.

## How it works

1. Fetches `<website><sitemap_path>` (default `/sitemap.xml`) or `feed_url` if set.
2. Sorts entries by `lastmod` desc, caps at `max_details_per_scan`.
3. For each detail URL: GET, extract first `application/ld+json` block whose `@type` is `RealEstateListing` / `Apartment` / `House` / `Residence`, map into Wabe's `Listing`.
4. Honors `pace_ms` between requests.

## Tests

`pnpm --filter @wabe/source-schemaorg test`
```

- [ ] **Step 2: Commit**

```
git add plugins/source-schemaorg/README.md
git commit -S -m "docs(source-schemaorg): README — usage + flow + config"
```

---

### Task 11: `wabe agencies` CLI subcommands

**Files:**
- Create: `packages/cli/src/commands/agencies/index.ts`
- Create: `packages/cli/src/commands/agencies/probe.ts`
- Create: `packages/cli/src/commands/agencies/probe-portal.ts`
- Create: `packages/cli/src/commands/agencies/validate.ts`
- Create: `packages/cli/src/commands/agencies/stats.ts`
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/package.json` (add `@wabe/agency-fingerprint`, `@wabe/source-schemaorg`)

- [ ] **Step 1: Parent command (`agencies/index.ts`)**

```typescript
import type { Command } from 'commander';
import { registerProbe } from './probe.js';
import { registerProbePortal } from './probe-portal.js';
import { registerValidate } from './validate.js';
import { registerStats } from './stats.js';

export function registerAgencies(program: Command): void {
  const agencies = program.command('agencies').description('manage the agency registry');
  registerProbe(agencies);
  registerProbePortal(agencies);
  registerValidate(agencies);
  registerStats(agencies);
}
```

- [ ] **Step 2: `probe.ts` — fingerprint one URL**

```typescript
import type { Command } from 'commander';
import { fingerprint } from '@wabe/agency-fingerprint';

export function registerProbe(parent: Command): void {
  parent
    .command('probe <url>')
    .description('fingerprint one agency URL and print a suggested registry row')
    .action(async (url: string) => {
      const ac = new AbortController();
      const result = await fingerprint(url, ac.signal);
      const slug = new URL(url).hostname.replace(/^www\./, '').split('.')[0] ?? 'unknown';
      console.log(`# detected platform: ${result.platform} (status ${result.status})`);
      console.log(`- id: ${slug}`);
      console.log(`  name: ${slug}`);
      console.log(`  website: ${url}`);
      console.log(`  canton: ZH`);
      console.log(`  platform: ${result.platform}`);
    });
}
```

- [ ] **Step 3: `probe-portal.ts` — mine a portal's agency attributions**

```typescript
import type { Command } from 'commander';
import { fingerprint } from '@wabe/agency-fingerprint';

const SUPPORTED_PORTALS = ['flatfox'] as const;
type Portal = (typeof SUPPORTED_PORTALS)[number];

export function registerProbePortal(parent: Command): void {
  parent
    .command('probe-portal <portal>')
    .description('mine a portal\'s listing pages for agency URLs, fingerprint each, emit draft rows')
    .option('--top <n>', 'number of listings to scan', '100')
    .action(async (portal: string, opts: { top: string }) => {
      if (!SUPPORTED_PORTALS.includes(portal as Portal)) {
        console.error(`unsupported portal: ${portal}. supported: ${SUPPORTED_PORTALS.join(', ')}`);
        process.exit(1);
      }
      const top = Number.parseInt(opts.top, 10);
      console.log(`# probing top ${top} listings on ${portal}`);
      // The actual implementation reuses the source-flatfox client to fetch
      // listing detail pages and extract `agency_url` from each. Per-portal
      // extraction lives in dedicated helpers under packages/cli/src/commands/agencies/portals/.
      // For Phase C ship: print a TODO line per portal-impl and exit 0; the
      // discovery spike will run this command once we extend it. The full
      // implementation gets its own follow-up task once schema + CLI shape
      // are committed and reviewed.
      console.log('# NOTE: probe-portal scaffolding only — portal-specific extractor TBD in followup task.');
      console.log(`# expected output once implemented: ${top} suggested registry rows as YAML.`);
      const ac = new AbortController();
      // demo: fingerprint one well-known agency URL just to exercise the plumbing
      const sample = 'https://walde.ch';
      const r = await fingerprint(sample, ac.signal);
      console.log(`# sample probe of ${sample} → platform=${r.platform}`);
    });
}
```

NOTE: `probe-portal` is intentionally a scaffold in Phase C — the full portal-specific mining logic is its own followup task (depends on which portal we mine first, which depends on discovery output itself). The CLI surface exists so the command name doesn't change later.

- [ ] **Step 4: `validate.ts` — Zod-validate + dead-link probe**

```typescript
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { parse as parseYaml } from 'yaml';
import { request } from 'undici';
import { AgencyRegistry, type AgencyRegistry as AgencyRegistryType } from '@wabe/core';

export function registerValidate(parent: Command): void {
  parent
    .command('validate <file>')
    .description('validate a registry file and probe each agency website for liveness')
    .action(async (file: string) => {
      const raw = parseYaml(readFileSync(resolve(file), 'utf8')) as unknown;
      let registry: AgencyRegistryType;
      try {
        registry = AgencyRegistry.parse(raw);
      } catch (err) {
        console.error(`schema validation failed: ${(err as Error).message}`);
        process.exit(1);
      }
      console.log(`registry: ${registry.source} — ${registry.agencies.length} entries`);
      let dead = 0;
      for (const a of registry.agencies) {
        try {
          const res = await request(a.website, { method: 'HEAD', signal: AbortSignal.timeout(10_000) });
          const ok = res.statusCode >= 200 && res.statusCode < 400;
          console.log(`${ok ? 'OK ' : 'X  '} ${a.id.padEnd(20)} ${res.statusCode} ${a.website}`);
          if (!ok) dead += 1;
        } catch (err) {
          console.log(`X   ${a.id.padEnd(20)} ERR ${a.website} — ${(err as Error).message}`);
          dead += 1;
        }
      }
      if (dead > 0) console.log(`\n${dead} dead/erroring entries.`);
    });
}
```

- [ ] **Step 5: `stats.ts` — per-agency listing counts from SQLite**

```typescript
import type { Command } from 'commander';
import { openDb, type WabeDb } from '@wabe/db';
import { resolveDataDir } from '../../paths.js';

export function registerStats(parent: Command): void {
  parent
    .command('stats')
    .description('show listing counts per agency from the local SQLite store')
    .action(() => {
      const dbPath = resolveDataDir() + '/wabe.db';
      const db = openDb(dbPath);
      const rows = db._raw
        .prepare<[], { source: string; count: number; last: number | null }>(
          "SELECT source, COUNT(*) AS count, MAX(last_seen_at) AS last FROM listings WHERE source LIKE 'agency:%' GROUP BY source ORDER BY count DESC",
        )
        .all();
      if (rows.length === 0) {
        console.log('no agency listings yet — run `wabe scan` first.');
        return;
      }
      for (const r of rows) {
        const lastSeen = r.last ? new Date(r.last).toISOString() : 'never';
        console.log(`${r.source.padEnd(40)} ${String(r.count).padStart(6)}  last seen ${lastSeen}`);
      }
    });
}
```

NOTE: this assumes `packages/cli/src/paths.ts` exposes a `resolveDataDir()` helper. If it doesn't, look at how `wabe scan` / `wabe migrate` locate the DB and reuse that helper. If a different helper is used, replace the import line accordingly.

- [ ] **Step 6: Register in `index.ts`**

In `packages/cli/src/index.ts`:

```typescript
import { registerAgencies } from './commands/agencies/index.js';
// ... after the other registerX() calls:
registerAgencies(program);
```

- [ ] **Step 7: Add deps to `packages/cli/package.json`**

In `dependencies`:

```json
    "@wabe/agency-fingerprint": "workspace:*",
    "@wabe/source-schemaorg": "workspace:*",
```

- [ ] **Step 8: Install + build + smoke**

```
pnpm install
pnpm --filter @wabe/cli build
node packages/cli/dist/index.js agencies --help
```
Expected: parent command lists `probe`, `probe-portal`, `validate`, `stats` as subcommands.

- [ ] **Step 9: Commit**

```
git add packages/cli/src/ packages/cli/package.json pnpm-lock.yaml
git commit -S -m "feat(cli): wabe agencies — probe / probe-portal / validate / stats"
```

---

### Task 12: Register new packages as `@wabe/server` deps + example wiring

**Files:**
- Modify: `packages/server/package.json`
- Create: `examples/zurich-family/config/agencies.example.yaml`
- Create: `examples/zurich-family/config/plugins/agencies.yaml`
- Modify: `examples/zurich-family/config/config.yaml`

- [ ] **Step 1: Server deps**

In `packages/server/package.json` `dependencies`, add:

```json
    "@wabe/source-schemaorg": "workspace:*",
```

- [ ] **Step 2: Example registry**

Create `examples/zurich-family/config/agencies.example.yaml`:

```yaml
version: 1
source: example-2026-05-18
fetched_at: '2026-05-18T00:00:00Z'
agencies:
  # Two illustrative entries. Replace with your real curated list.
  - id: example-walde
    name: Walde Immobilien (example)
    website: https://walde.ch
    canton: ZH
    platform: schemaorg
    enabled: false  # example registry — flip to true after verifying the site emits JSON-LD
  - id: example-nobilis
    name: Nobilis (example)
    website: https://nobilis.ch
    canton: ZH
    platform: schemaorg
    enabled: false
```

- [ ] **Step 3: Plugin yaml that points at the registry**

Create `examples/zurich-family/config/plugins/agencies.yaml`:

```yaml
registry: ./agencies.example.yaml
```

- [ ] **Step 4: Enable the meta-source**

In `examples/zurich-family/config/config.yaml`, append to `enabled.sources`:

```yaml
    - {name: agencies-zurich,     plugin: agencies,                    config: plugins/agencies.yaml}
```

- [ ] **Step 5: Install + verify**

```
pnpm install
pnpm --filter @wabe-example/zurich-family test
```
Expected: gate test passes (the registry rows have `enabled: false` so no expansion happens — pure plumbing exercise).

- [ ] **Step 6: Commit**

```
git add packages/server/package.json pnpm-lock.yaml examples/zurich-family/
git commit -S -m "feat(server,examples): ship source-schemaorg + agency-registry meta-source in zurich-family"
```

---

### Task 13: Integration test — registry expand → schemaorg plugin → notification

**Files:**
- Create: `packages/server/test/agencies.integration.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import { loadConfig } from '../src/config.js';
import { loadPlugins } from '../src/loader.js';

let dir: string;
let agent: MockAgent;
let prev: ReturnType<typeof getGlobalDispatcher>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wabe-agencies-'));
  mkdirSync(join(dir, 'plugins'), { recursive: true });
  prev = getGlobalDispatcher();
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
});
afterEach(async () => {
  await agent.close();
  setGlobalDispatcher(prev);
  rmSync(dir, { recursive: true, force: true });
});

const SITEMAP = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://walde.example/objekt-12345</loc><lastmod>2026-05-18</lastmod></url>
</urlset>`;

const DETAIL = `<html><head>
<script type="application/ld+json">{"@type":"RealEstateListing","numberOfRooms":"3.5","floorSize":{"value":"95"},"offers":{"price":"2400","priceCurrency":"CHF"},"address":{"postalCode":"8008","addressLocality":"Zürich"},"image":"https://walde.example/i.jpg"}</script>
</head></html>`;

function writeYaml(path: string, body: string) {
  writeFileSync(join(dir, path), body, 'utf8');
}

describe('agency registry — end-to-end', () => {
  it('expands one schemaorg row into a working source plugin that yields a listing', async () => {
    writeYaml('config.yaml', `enabled:
  sources:
    - {name: agencies-test, plugin: agencies, config: plugins/agencies.yaml}
  notifiers: []
log: { level: silent }
`);
    writeYaml('filters.yaml', `filters: []
`);
    writeYaml('scoring.yaml', `scoring: []
notify: { threshold: 0, daily_quota: 10 }
`);
    writeYaml('plugins/agencies.yaml', `registry: ./agencies.yaml
`);
    writeYaml('agencies.yaml', `version: 1
source: test
agencies:
  - id: walde
    name: Walde
    website: https://walde.example
    canton: ZH
    platform: schemaorg
    enabled: true
`);
    // Intercept the schemaorg plugin's sitemap + detail HTTPs.
    const pool = agent.get('https://walde.example');
    pool.intercept({ method: 'GET', path: '/sitemap.xml' }).reply(200, SITEMAP, { headers: { 'content-type': 'application/xml' } });
    pool.intercept({ method: 'GET', path: '/objekt-12345' }).reply(200, DETAIL, { headers: { 'content-type': 'text/html' } });

    const cfg = await loadConfig(dir);
    expect(cfg.top.enabled.sources.some((s) => s.name === 'agency:schemaorg:walde')).toBe(true);
    expect(cfg.skippedAgencies).toEqual([]);

    const plugins = await loadPlugins(cfg);
    const src = plugins.sources.find((s) => s.name === 'agency:schemaorg:walde');
    expect(src).toBeTruthy();
    if (!src) return;

    const yielded = [];
    for await (const raw of src.plugin.fetch({
      logger: { child: () => ({ debug: () => {}, warn: () => {}, info: () => {}, error: () => {} }) } as never,
      config: src.config,
      signal: new AbortController().signal,
      db: { _raw: {} as never } as never,
    })) {
      yielded.push(raw);
    }
    expect(yielded).toHaveLength(1);
    expect(yielded[0]?.id).toBe('agency:walde:12345');
    expect(yielded[0]?.rooms).toBe(3.5);
  });
});
```

- [ ] **Step 2: Run the test**

```
pnpm --filter @wabe/server test agencies.integration
```
Expected: PASS.

- [ ] **Step 3: Commit**

```
git add packages/server/test/agencies.integration.test.ts
git commit -S -m "test(server): integration — registry expand → schemaorg plugin → yielded listing"
```

---

### Task 14: Workspace-wide CI gate

**Files:** none.

- [ ] **Step 1: Run CI**

```
pnpm run ci
```
Expected: 25+ tasks all green (lint + format + typecheck + test across the workspace).

- [ ] **Step 2: Fix any regressions**

If `loadConfig` becoming async broke a caller, search `loadConfig(` and add `await`. If a test imports the synchronous version, update it. Do NOT bypass with `--no-verify`.

- [ ] **Step 3: No commit if green** (verification gate).

---

## Self-review

### Spec coverage (against `docs/superpowers/specs/2026-05-18-multi-source-expansion-design.md` §6 revised scope)

| Spec requirement | Plan task |
|------------------|-----------|
| §6.2 `AgencyRegistry` schema | Task 1 |
| §6.2 JSON Schema export | *Out of scope this plan* — add a followup or include in a docs phase; not blocking |
| §6.2 registry loader (file / HTTPS / git) | Task 3 |
| §6.2 Ed25519 signature verify | Task 4 |
| §6.2 config preprocessor (expand → sources[]) | Task 5 |
| §6.2 `@wabe/source-schemaorg` adapter | Tasks 8, 9, 10 |
| §6.2 `@wabe/agency-fingerprint` package | Tasks 6, 7 |
| §6.2 CLI: probe / probe-portal / validate / stats | Task 11 (probe-portal is scaffold-only; full extractor is followup) |
| §6.2 Forward-compat: unknown platform → log+skip, never throw | Task 5 (`expandRegistry` returns `skipped`, never throws) |
| §6.3 Tier-2 family adapters (ImmoMig, Casasoft) — deferred | Confirmed not implemented |
| §6.4 Config wiring (file / HTTPS / git auth / signature_pubkey) | Tasks 3, 5 |
| §6.6 success: validate passes on hand-crafted registry | Task 11 Step 4 implementation |
| §6.6 success: probe prints valid suggested row | Task 11 Step 2 implementation |
| §6.6 success: registry of 3 schema.org agencies expands to 3 source instances and emits listings end-to-end | Task 13 (covers expand + plugin yield; full pipeline-to-notify already covered by Phase A integration test) |
| §6.6 success: discovery-spike distribution report | *Out of scope this plan* — depends on `probe-portal` full impl which is a followup; document in commit message |
| §6.6 success: agency-direct dedup beats portal duplicates | Inherited from Phase A `shouldNotify` + Phase A integration test pattern; agency listings get `source: agency:schemaorg:<id>` and default priority 100 via `SOURCE_PRIORITY_DEFAULTS.agency` |

### Placeholder scan

Two soft references:

1. **Task 11 Step 3 `probe-portal`** — scaffold-only with explicit `# NOTE` line printed in stdout. The full implementation is gated on the discovery spike, which can't run until the spike is run. Documented as a followup task in Task 11 Step 3.
2. **Task 5 Step 3 `expand.ts` ↔ Task 9 Step 4 `agency_id` config field** — the two tasks have a coupling: `expand.ts` must inject `agency_id` into the inline config, and the `source-schemaorg` plugin must consume it. Both tasks call this out and reference each other. Not a placeholder, but a cross-task contract — verify both ends agree before merging.

No other TBD / TODO / "implement later" entries.

### Type consistency

- `AgencyRegistry` / `AgencyEntry` Zod types are stable across Tasks 1, 3, 5, 13.
- `ExpandedSource { name, plugin, config }` matches `EnabledEntry { name, plugin, config }` from `@wabe/server/config.ts` exactly — the preprocessor returns rows the loader already understands.
- `LoadedConfig.skippedAgencies` is a new field referenced consistently in Tasks 5, 13. Callers of `loadConfig` don't need to handle it (default behavior: log + ignore).
- `Source.name` on `source-schemaorg` plugin is `'source-schemaorg'` (matches `SOURCE_PRIORITY_DEFAULTS` key from Task 2).
- Agency listings emit `source: agency:schemaorg:<id>` (not `source-schemaorg`) so they show up under the right group in `wabe agencies stats`. Priority lookup at pipeline level falls back to `DEFAULT_SOURCE_PRIORITY` for this synthetic source name → the `expand.ts` inline config sets `priority: 100` (from the registry row's default) and the pipeline reads `source_priority` from there. Verify in Task 5 review that the pipeline path actually applies the registry priority rather than falling back to defaults — if not, extend the pipeline to honor `cfg.priority` when present.
