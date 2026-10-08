/**
 * Chaingraph client tests against a fake GraphQL HTTP server (no network).
 */
import { test, expect, describe, afterEach } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import {
  createChaingraphBackend,
  chaingraphQuery,
  embedResolution,
  fetchBCMROutputs,
  getChaingraphStats,
  toBytea,
} from '../../src/lib/chaingraph-client.js';

type Handler = (query: string, variables: any) => { data?: unknown; errors?: Array<{ message: string }> } | 'hang' | 'http500';

interface FakeGraphql {
  server: Server;
  url: string;
  requests: Array<{ query: string; variables: any }>;
}

const servers: FakeGraphql[] = [];

async function startGraphql(handler: Handler): Promise<FakeGraphql> {
  const fake: FakeGraphql = { server: null as unknown as Server, url: '', requests: [] };
  fake.server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const { query, variables } = JSON.parse(body);
      fake.requests.push({ query, variables });
      const reply = handler(query, variables);
      if (reply === 'hang') return; // never answer
      if (reply === 'http500') {
        res.writeHead(500, 'boom');
        res.end('boom');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  fake.url = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}/v1/graphql`;
  servers.push(fake);
  return fake;
}

afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.server.closeAllConnections?.();
    await new Promise<void>((resolve) => s.server.close(() => resolve()));
  }
});

const txA = 'aa'.repeat(32);
const txB = 'bb'.repeat(32);
const txC = 'cc'.repeat(32);
const parentA = 'ee'.repeat(32);

/** Handler answering the three query kinds for the chain A -> B -> C */
function chainHandler(): Handler {
  const spends: Record<string, string | null> = { [txA]: txB, [txB]: txC, [txC]: null };
  const parents: Record<string, string> = { [txA]: parentA, [txB]: txA, [txC]: txB };
  return (query, variables) => {
    const hashes: string[] = (variables.h as string[]).map((h) => h.slice(2));
    if (query.includes('spent_by')) {
      return {
        data: {
          output: hashes
            .filter((h) => h in spends)
            .map((h) => ({
              transaction_hash: toBytea(h),
              spent_by: spends[h] ? [{ transaction: { hash: toBytea(spends[h] as string) } }] : [],
            })),
        },
      };
    }
    if (query.includes('authchains')) {
      return {
        data: {
          transaction: hashes
            .filter((h) => h in spends)
            .map((h) => ({
              hash: toBytea(h),
              authchains: [{ authhead_transaction_hash: toBytea(txC), authchain_length: String(h === txA ? 3 : h === txB ? 2 : 1), unspent_authhead: true }],
              inputs: [{ outpoint_transaction_hash: toBytea(parents[h]), outpoint_index: '0' }],
            })),
        },
      };
    }
    if (query.includes('inputs')) {
      return {
        data: {
          transaction: hashes
            .filter((h) => h in parents)
            .map((h) => ({ hash: toBytea(h), inputs: [{ outpoint_transaction_hash: toBytea(parents[h]) }] })),
        },
      };
    }
    return { errors: [{ message: `unexpected query: ${query.slice(0, 40)}` }] };
  };
}

describe('createChaingraphBackend', () => {
  test('concurrent spend lookups are answered by one batched request', async () => {
    const fake = await startGraphql(chainHandler());
    const backend = createChaingraphBackend({ url: fake.url });

    const results = await Promise.all([backend.getSpendingTx(txA), backend.getSpendingTx(txB), backend.getSpendingTx(txC), backend.getSpendingTx(txA)]);
    expect(results).toEqual([txB, txC, null, txB]);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0].variables.h.sort()).toEqual([toBytea(txA), toBytea(txB), toBytea(txC)].sort());
  });

  test('parent lookups return input 0 outpoint and are batched separately', async () => {
    const fake = await startGraphql(chainHandler());
    const backend = createChaingraphBackend({ url: fake.url });

    const [pa, sb] = await Promise.all([backend.getParentTxId(txA), backend.getSpendingTx(txB)]);
    expect(pa).toBe(parentA);
    expect(sb).toBe(txC);
    expect(fake.requests).toHaveLength(2);
  });

  test('resolveChain maps the server-side authchain', async () => {
    const fake = await startGraphql(chainHandler());
    const backend = createChaingraphBackend({ url: fake.url });

    await expect(backend.resolveChain!(txA)).resolves.toEqual({ authhead: txC, chainLength: 3, isActive: true });
    expect(backend.getStats!()['Chaingraph server-side chain resolutions']).toBe(1);
  });

  test('a transaction Chaingraph does not know is an error, not "unspent"', async () => {
    const fake = await startGraphql(chainHandler());
    const backend = createChaingraphBackend({ url: fake.url });
    await expect(backend.getSpendingTx('dd'.repeat(32))).rejects.toThrow(/not known to Chaingraph/);
  });

  test('a GraphQL error rejects every lookup in the batch', async () => {
    const fake = await startGraphql(() => ({ errors: [{ message: 'database unavailable' }] }));
    const backend = createChaingraphBackend({ url: fake.url });
    const results = await Promise.allSettled([backend.getSpendingTx(txA), backend.getSpendingTx(txB)]);
    for (const r of results) {
      expect(r.status).toBe('rejected');
      expect((r as PromiseRejectedResult).reason.message).toMatch(/database unavailable/);
    }
    expect(fake.requests).toHaveLength(1);
  });

  test('an HTTP error and a timeout reject', async () => {
    const bad = await startGraphql(() => 'http500');
    await expect(chaingraphQuery('{ x }', undefined, { url: bad.url })).rejects.toThrow(/500/);

    const slow = await startGraphql(() => 'hang');
    const before = getChaingraphStats().failures;
    await expect(chaingraphQuery('{ x }', undefined, { url: slow.url, timeoutMs: 200 })).rejects.toThrow(/timed out after 200ms/);
    expect(getChaingraphStats().failures).toBe(before + 1);
  });
});

describe('embedResolution', () => {
  test('writes authchains and input 0 onto each row; unspent outputs skip the recursive query', async () => {
    const fake = await startGraphql(chainHandler());
    const rows = [txA, txB, txC, txA].map((h) => ({ transaction_hash: toBytea(h), transaction: { block_inclusions: [] } }));

    const result = await embedResolution(rows as any, { url: fake.url });
    expect(result).toEqual({ embedded: 4, unspent: 1, resolved: 2, failed: 0 });
    // One spend batch + one parent batch + one authchains batch (A and B only)
    expect(fake.requests).toHaveLength(3);
    const chainRequest = fake.requests.find((r) => r.query.includes('authchains'))!;
    expect(chainRequest.variables.h.sort()).toEqual([toBytea(txA), toBytea(txB)].sort());
    expect((rows[0].transaction as any).authchains[0].authhead_transaction_hash).toBe(toBytea(txC));
    expect((rows[0].transaction as any).inputs[0].outpoint_transaction_hash).toBe(toBytea(parentA));
    expect((rows[2].transaction as any).authchains[0]).toEqual({ authhead_transaction_hash: toBytea(txC), authchain_length: 1, unspent_authhead: true });
  });

  test('a failing authchains batch is split and a single failing transaction is skipped', async () => {
    const base = chainHandler();
    const fake = await startGraphql((query, variables) => {
      // The recursive query fails whenever B is in the batch
      if (query.includes('authchains') && variables.h.includes(toBytea(txB))) {
        return { errors: [{ message: 'statement timeout' }] };
      }
      return base(query, variables);
    });
    const rows = [txA, txB, txC].map((h) => ({ transaction_hash: toBytea(h), transaction: {} }));

    const result = await embedResolution(rows as any, { url: fake.url });
    expect(result).toEqual({ embedded: 2, unspent: 1, resolved: 1, failed: 1 });
    expect((rows[0].transaction as any).authchains[0].authchain_length).toBe('3');
    expect((rows[1].transaction as any).authchains).toBeUndefined();
  });
});

describe('fetchBCMROutputs', () => {
  test('pages through the search function until a short page', async () => {
    const total = 2345;
    const fake = await startGraphql((query, variables) => {
      expect(query).toContain('order_by');
      const { limit, offset } = variables;
      const rows = [];
      for (let i = offset; i < Math.min(offset + limit, total); i++) {
        rows.push({ transaction_hash: toBytea(i.toString(16).padStart(64, '0')), output_index: '1' });
      }
      return { data: { search_output_prefix: rows } };
    });

    const pages: number[] = [];
    const rows = await fetchBCMROutputs<{ transaction_hash: string }>({ url: fake.url, pageSize: 1000, onPage: (n) => pages.push(n) });

    expect(rows).toHaveLength(total);
    expect(new Set(rows.map((r) => r.transaction_hash)).size).toBe(total);
    expect(fake.requests.map((r) => r.variables.offset)).toEqual([0, 1000, 2000]);
    expect(pages).toEqual([1000, 2000, 2345]);
  });

  test('an exact multiple of the page size needs one extra empty page', async () => {
    const fake = await startGraphql((_query, variables) => {
      const { limit, offset } = variables;
      const rows = [];
      for (let i = offset; i < Math.min(offset + limit, 2000); i++) {
        rows.push({ transaction_hash: toBytea(i.toString(16).padStart(64, '0')) });
      }
      return { data: { search_output_prefix: rows } };
    });
    const rows = await fetchBCMROutputs({ url: fake.url, pageSize: 1000 });
    expect(rows).toHaveLength(2000);
    expect(fake.requests).toHaveLength(3);
  });
});
