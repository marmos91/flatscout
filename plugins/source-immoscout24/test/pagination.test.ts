import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import type { Context } from '@wabe/plugin-sdk';

const logger = pino({ level: 'silent' });

interface StubCall {
  url: string;
  readState?: { jsPath: string; actions?: Array<{ kind: string; [k: string]: unknown }> };
}

interface PageJson {
  listings: Array<{ id: string; listing: Record<string, unknown> }>;
  page: number;
  pageCount: number;
  resultCount: number;
  itemsPerPage: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

function page(p: number, ids: string[], pageCount: number, total: number): PageJson {
  return {
    listings: ids.map((id) => ({ id, listing: {} })),
    page: p,
    pageCount,
    resultCount: total,
    itemsPerPage: 20,
    hasNextPage: p < pageCount,
    hasPreviousPage: p > 1,
  };
}

/**
 * Builds a stub Transport that returns a queued sequence of read-state JSON
 * payloads, then records every call for assertion.
 */
function makeStubTransport(payloads: PageJson[]): {
  transport: import('../src/transport.js').Transport;
  calls: StubCall[];
} {
  const calls: StubCall[] = [];
  let i = 0;
  const transport: import('../src/transport.js').Transport = {
    kind: 'bridge-inproc',
    async request(opts) {
      calls.push({ url: opts.url, readState: opts.readState });
      const p = payloads[i++];
      if (!p) {
        return { status: 500, body: 'no more stub payloads' };
      }
      return { status: 200, body: JSON.stringify({ result: p }) };
    },
  };
  return { transport, calls };
}

// Pre-empt the transport selector so the plugin under test consumes our stub
// instead of trying to reach a real bridge.
vi.mock('../src/transport.js', async () => {
  const actual = await vi.importActual<typeof import('../src/transport.js')>('../src/transport.js');
  return {
    ...actual,
    selectTransport: vi.fn(),
  };
});

import pluginExport from '../src/index.js';
import * as transportModule from '../src/transport.js';

function makeCtx(config: unknown): Context {
  return {
    logger,
    config,
    signal: new AbortController().signal,
    db: undefined,
  };
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iter) out.push(v);
  return out;
}

const baseConfig = {
  schedule: '*/15 * * * *',
  search: {
    zipcodes: [],
    property_type: 'APARTMENT_OR_HOUSE' as const,
    offer_type: 'RENT' as const,
    sort_by: 'dateCreated' as const,
    sort_direction: 'desc' as const,
    language: 'en' as const,
  },
  fetch: { max_pages: 3, pace_ms: 0, backoff: { on: [], retries: 0, base_ms: 1 } },
  enrich: { enrich_via_bridge: false, max_detail_per_scan: 40 },
};

describe('source-immoscout24 pagination', () => {
  it('walks 3 pages via read-state actions and dedups overlapping ids', async () => {
    const { transport, calls } = makeStubTransport([
      page(1, ['a', 'b', 'c'], 3, 7),
      page(2, ['c', 'd', 'e'], 3, 7),
      page(3, ['e', 'f', 'g'], 3, 7),
    ]);
    vi.mocked(transportModule.selectTransport).mockResolvedValue(transport);

    const listings = await collect(pluginExport.plugin.fetch(makeCtx(baseConfig)));

    // 7 unique ids across 3 pages, in first-emission order.
    const ids = listings.map((l) => l.id);
    expect(ids).toEqual([
      'immoscout24:a',
      'immoscout24:b',
      'immoscout24:c',
      'immoscout24:d',
      'immoscout24:e',
      'immoscout24:f',
      'immoscout24:g',
    ]);

    // First read carries no actions; subsequent reads carry eval + wait_for.
    expect(calls).toHaveLength(3);
    expect(calls[0]?.readState?.actions).toBeUndefined();
    expect(calls[1]?.readState?.actions?.map((a) => a.kind)).toEqual(['eval', 'wait_for']);
    expect(calls[2]?.readState?.actions?.map((a) => a.kind)).toEqual(['eval', 'wait_for']);
    // The wait_for predicate targets the next page number on each step.
    const wait1 = calls[1]?.readState?.actions?.[1] as { js_predicate: string } | undefined;
    const wait2 = calls[2]?.readState?.actions?.[1] as { js_predicate: string } | undefined;
    expect(wait1?.js_predicate).toMatch(/===\s*2/);
    expect(wait2?.js_predicate).toMatch(/===\s*3/);
  });

  it('stops at hasNextPage=false before max_pages is reached', async () => {
    const { transport, calls } = makeStubTransport([
      page(1, ['a'], 2, 2),
      { ...page(2, ['b'], 2, 2), hasNextPage: false },
    ]);
    vi.mocked(transportModule.selectTransport).mockResolvedValue(transport);

    const listings = await collect(
      pluginExport.plugin.fetch(makeCtx({ ...baseConfig, fetch: { ...baseConfig.fetch, max_pages: 5 } })),
    );

    expect(listings.map((l) => l.id)).toEqual(['immoscout24:a', 'immoscout24:b']);
    expect(calls).toHaveLength(2);
  });

  it('stops if pagination did not advance (same page returned twice)', async () => {
    const { transport } = makeStubTransport([
      page(1, ['a'], 5, 50),
      // Page didn't advance — defensive guard should break the loop.
      page(1, ['a', 'z'], 5, 50),
    ]);
    vi.mocked(transportModule.selectTransport).mockResolvedValue(transport);

    const listings = await collect(pluginExport.plugin.fetch(makeCtx(baseConfig)));

    // Only the first read's ids should have been emitted; the second read
    // triggers the "did not advance" warning + break.
    expect(listings.map((l) => l.id)).toEqual(['immoscout24:a']);
  });

  it('respects max_pages cap even when more pages exist', async () => {
    const { transport, calls } = makeStubTransport([page(1, ['a'], 10, 100), page(2, ['b'], 10, 100)]);
    vi.mocked(transportModule.selectTransport).mockResolvedValue(transport);

    await collect(
      pluginExport.plugin.fetch(makeCtx({ ...baseConfig, fetch: { ...baseConfig.fetch, max_pages: 2 } })),
    );

    expect(calls).toHaveLength(2);
  });
});
