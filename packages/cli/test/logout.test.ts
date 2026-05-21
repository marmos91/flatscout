import { describe, expect, it } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from 'undici';
import { AUTH_BASE, CLIENT_ID } from '@flatscout/source-homegate';
import { revokeRefreshToken } from '../src/commands/logout.js';

function withMock<T>(fn: (agent: MockAgent) => Promise<T>): Promise<T> {
  const prev: Dispatcher = getGlobalDispatcher();
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  return fn(agent).finally(async () => {
    await agent.close();
    setGlobalDispatcher(prev);
  });
}

describe('revokeRefreshToken', () => {
  it('POSTs JSON {client_id, token} to /oauth/revoke and returns true on 200', async () => {
    await withMock(async (agent) => {
      const pool = agent.get(AUTH_BASE);
      let observedBody: string | undefined;
      let observedHeaders: Record<string, string | string[] | undefined> | undefined;
      let observedMethod: string | undefined;
      pool.intercept({ method: 'POST', path: '/oauth/revoke' }).reply((opts) => {
        observedBody = typeof opts.body === 'string' ? opts.body : undefined;
        observedHeaders = opts.headers as Record<string, string | string[] | undefined>;
        observedMethod = opts.method;
        return { statusCode: 200, data: '' };
      });

      const ok = await revokeRefreshToken('rf-secret-xyz');
      expect(ok).toBe(true);
      expect(observedMethod).toBe('POST');
      expect(observedBody).toBeDefined();
      const parsed = JSON.parse(observedBody as string);
      expect(parsed).toEqual({ client_id: CLIENT_ID, token: 'rf-secret-xyz' });
      // Headers can come back as a plain object keyed by lowercase name.
      const hdrs = observedHeaders ?? {};
      const ctype = (hdrs['content-type'] ?? hdrs['Content-Type']) as string | undefined;
      expect(ctype).toMatch(/application\/json/i);
    });
  });

  it('returns false on a non-2xx response (best-effort, never throws)', async () => {
    await withMock(async (agent) => {
      const pool = agent.get(AUTH_BASE);
      pool.intercept({ method: 'POST', path: '/oauth/revoke' }).reply(500, 'oops');
      const ok = await revokeRefreshToken('rf-secret-xyz');
      expect(ok).toBe(false);
    });
  });

  it('returns false when the network call throws (best-effort, never throws)', async () => {
    await withMock(async (agent) => {
      const pool = agent.get(AUTH_BASE);
      pool.intercept({ method: 'POST', path: '/oauth/revoke' }).replyWithError(new Error('socket reset'));
      const ok = await revokeRefreshToken('rf-secret-xyz');
      expect(ok).toBe(false);
    });
  });
});
