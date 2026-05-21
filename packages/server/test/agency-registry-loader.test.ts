import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import { loadRegistry } from '../src/agency-registry/loader.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flatscout-reg-'));
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
