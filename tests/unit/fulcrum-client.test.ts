/**
 * Fulcrum client tests against a fake Electrum WebSocket server.
 * No network access: each test starts its own server on a random port.
 */
import { test, expect, describe, afterEach } from 'vitest';
import { WebSocketServer, type WebSocket as WS, type RawData } from 'ws';
import type { AddressInfo } from 'net';

type WSS = InstanceType<typeof WebSocketServer>;

// The pool reads FULCRUM_WS_URL when it is created (first call), so the
// placeholder just has to exist before import; each test points it at its server.
process.env.FULCRUM_WS_URL = 'ws://127.0.0.1:1';
const client = await import('../../src/lib/fulcrum-client.js');

type Reply = { result: unknown } | { error: string } | 'drop' | 'ignore';
type Handler = (method: string, params: any[], ws: WS) => Reply | Promise<Reply>;

interface FakeServer {
  wss: WSS;
  url: string;
  calls: string[];
  requests: Array<{ method: string; params: any[] }>;
}

const servers: FakeServer[] = [];

/**
 * Start a fake Electrum server. `handler` decides what each request gets:
 * a result, a JSON-RPC error, 'drop' (terminate the socket) or 'ignore' (no reply).
 */
async function startServer(handler: Handler, options: { rejectFirst?: number } = {}): Promise<FakeServer> {
  let rejected = 0;
  const wss = new WebSocketServer({
    port: 0,
    host: '127.0.0.1',
    verifyClient: (_info: unknown, cb: (ok: boolean, code?: number) => void) => {
      if (options.rejectFirst && rejected < options.rejectFirst) {
        rejected++;
        cb(false, 503);
      } else {
        cb(true);
      }
    },
  });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  const server: FakeServer = {
    wss,
    url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
    calls: [],
    requests: [],
  };

  wss.on('connection', (ws: WS) => {
    ws.on('message', async (data: RawData) => {
      const { id, method, params } = JSON.parse(data.toString());
      server.calls.push(method);
      server.requests.push({ method, params });
      const reply = await handler(method, params, ws);
      if (reply === 'drop') {
        ws.terminate();
      } else if (reply === 'ignore') {
        // never answer
      } else if ('error' in reply) {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -1, message: reply.error } }));
      } else {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, result: reply.result }));
      }
    });
  });

  servers.push(server);
  process.env.FULCRUM_WS_URL = server.url;
  return server;
}

afterEach(async () => {
  await client.closeConnectionPool();
  delete process.env.FULCRUM_REQUEST_TIMEOUT_MS;
  for (const s of servers.splice(0)) {
    for (const c of s.wss.clients) c.terminate();
    await new Promise<void>((resolve) => s.wss.close(() => resolve()));
  }
});

describe('connection failures', () => {
  test('a socket terminated mid-request rejects promptly instead of hanging', async () => {
    await startServer(() => 'drop');

    const started = Date.now();
    await expect(client.getTransaction('aa'.repeat(32))).rejects.toThrow(/connection closed/);
    expect(Date.now() - started).toBeLessThan(5000);

    const stats = client.getFulcrumStats();
    expect(stats.droppedRequests).toBeGreaterThan(0);
  });

  test('a request dropped once is retried on another socket and succeeds', async () => {
    let drops = 0;
    await startServer(() => {
      if (drops < 1) {
        drops++;
        return 'drop';
      }
      return { result: { txid: 'ok', vin: [], vout: [] } };
    });

    const tx = await client.getTransaction('aa'.repeat(32));
    expect(tx.txid).toBe('ok');
    expect(drops).toBe(1);
  });

  test('a request that is never answered times out and the pool keeps working', async () => {
    process.env.FULCRUM_REQUEST_TIMEOUT_MS = '300';
    await startServer((_method, params) =>
      params[0] === 'slow' ? 'ignore' : { result: { txid: params[0], vin: [], vout: [] } }
    );

    const started = Date.now();
    await expect(client.getTransaction('slow')).rejects.toThrow(/timed out after 300ms/);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(client.getFulcrumStats().timeouts).toBeGreaterThan(0);

    // The timed-out socket was discarded; other requests still work
    const tx = await client.getTransaction('fast');
    expect(tx.txid).toBe('fast');
  });

  test('a failed pool initialisation is discarded and the next call retries', async () => {
    // The first 3 connection attempts are refused; a 10-socket pool cannot be built
    await startServer(() => ({ result: { txid: 'ok', vin: [], vout: [] } }), { rejectFirst: 3 });

    await expect(client.getConnectionPool()).rejects.toThrow(/Failed to open 3\/10 Fulcrum connections/);

    // Second attempt: the server now accepts every connection
    const tx = await client.getTransaction('aa'.repeat(32));
    expect(tx.txid).toBe('ok');
  });

  test('a JSON-RPC error response rejects with the server message', async () => {
    await startServer(() => ({ error: 'no such transaction' }));
    await expect(client.getTransaction('aa'.repeat(32))).rejects.toThrow(/Fulcrum error: no such transaction/);
  });
});

describe('getOutputSpendingTx', () => {
  const txid = 'aa'.repeat(32);
  const spender = 'bb'.repeat(32);
  const p2pkh = '76a914' + '11'.repeat(20) + '88ac';
  const scripthash = client.calculateScripthash(p2pkh);

  function chainHandler(opts: { unspent: boolean; opReturn?: boolean; inHistory?: boolean }): Handler {
    return (method, params) => {
      switch (method) {
        case 'blockchain.transaction.get': {
          if (params[0] === txid) {
            return {
              result: {
                txid,
                vin: [],
                vout: [{ n: 0, value: 0.00001, scriptPubKey: { hex: opts.opReturn ? '6a0474657374' : p2pkh } }],
              },
            };
          }
          if (params[0] === spender) {
            return { result: { txid: spender, vin: [{ txid, vout: 0 }], vout: [] } };
          }
          return { error: `unknown tx ${params[0]}` };
        }
        case 'blockchain.scripthash.listunspent':
          expect(params[0]).toBe(scripthash);
          expect(params[1]).toBe('include_tokens'); // token-bearing auth UTXOs must be visible
          return { result: opts.unspent ? [{ tx_hash: txid, tx_pos: 0, height: 1, value: 1000 }] : [] };
        case 'blockchain.scripthash.get_history':
          expect(params[0]).toBe(scripthash);
          return {
            result: opts.inHistory === false
              ? [{ tx_hash: spender, height: 2 }]
              : [{ tx_hash: txid, height: 1 }, { tx_hash: spender, height: 2 }],
          };
        default:
          return { error: `unexpected method ${method}` };
      }
    };
  }

  test('an unspent output is answered by listunspent alone (no history walk)', async () => {
    const server = await startServer(chainHandler({ unspent: true }));
    await expect(client.getOutputSpendingTx(txid, 0)).resolves.toBeNull();
    expect(server.calls).toEqual(['blockchain.transaction.get', 'blockchain.scripthash.listunspent']);
  });

  test('a spent output walks the history to find the spender', async () => {
    const server = await startServer(chainHandler({ unspent: false }));
    await expect(client.getOutputSpendingTx(txid, 0)).resolves.toBe(spender);
    expect(server.calls).toEqual([
      'blockchain.transaction.get',
      'blockchain.scripthash.listunspent',
      'blockchain.scripthash.get_history',
      'blockchain.transaction.get',
    ]);
  });

  test('a spender far down a busy history is found without fetching the whole history', async () => {
    // History: our tx, then 40 unrelated txs, then the spender, then 200 more
    const unrelated = (i: number) => i.toString(16).padStart(64, '0');
    const history = [
      { tx_hash: txid, height: 1 },
      ...Array.from({ length: 40 }, (_, i) => ({ tx_hash: unrelated(i + 1), height: 2 })),
      { tx_hash: spender, height: 3 },
      ...Array.from({ length: 200 }, (_, i) => ({ tx_hash: unrelated(i + 100), height: 4 })),
    ];
    const server = await startServer((method, params) => {
      switch (method) {
        case 'blockchain.transaction.get':
          if (params[0] === txid) {
            return { result: { txid, vin: [], vout: [{ n: 0, value: 0, scriptPubKey: { hex: p2pkh } }] } };
          }
          if (params[0] === spender) {
            return { result: { txid: spender, vin: [{ txid, vout: 0 }], vout: [] } };
          }
          return { result: { txid: params[0], vin: [{ txid: 'ff'.repeat(32), vout: 1 }], vout: [] } };
        case 'blockchain.scripthash.listunspent':
          return { result: [] };
        case 'blockchain.scripthash.get_history':
          return { result: history };
        default:
          return { error: `unexpected method ${method}` };
      }
    });

    await expect(client.getOutputSpendingTx(txid, 0)).resolves.toBe(spender);
    const fetched = server.requests
      .filter((r) => r.method === 'blockchain.transaction.get')
      .map((r) => r.params[0]);
    // Every candidate before the spender was checked (none skipped), each once
    for (let i = 1; i <= 40; i++) expect(fetched).toContain(unrelated(i));
    expect(new Set(fetched).size).toBe(fetched.length);
    // Rounds of 1,2,4,8,16 cover 31 candidates; the spender sits in the next round of 16
    // (candidates 31-46). Nothing beyond that round is fetched, so of the 200 trailing
    // entries only the 6 sharing the spender's round are touched.
    expect(fetched.length).toBeLessThanOrEqual(1 + 31 + 16);
    expect(fetched).not.toContain(unrelated(107)); // candidate 47, first one past the round
    expect(fetched).not.toContain(unrelated(299));
  });

  test('an OP_RETURN output is unspendable and needs no scripthash queries', async () => {
    const server = await startServer(chainHandler({ unspent: false, opReturn: true }));
    await expect(client.getOutputSpendingTx(txid, 0)).resolves.toBeNull();
    expect(server.calls).toEqual(['blockchain.transaction.get']);
  });

  test('errors propagate instead of being reported as unspent', async () => {
    await startServer(() => ({ error: 'backend unavailable' }));
    await expect(client.getOutputSpendingTx(txid, 0)).rejects.toThrow(/Fulcrum error: backend unavailable/);
  });

  test('a missing output index is an error', async () => {
    await startServer(chainHandler({ unspent: true }));
    await expect(client.getOutputSpendingTx(txid, 5)).rejects.toThrow(/Output 5 does not exist/);
  });

  test('an output that is neither unspent nor in history is an error', async () => {
    await startServer(chainHandler({ unspent: false, inHistory: false }));
    await expect(client.getOutputSpendingTx(txid, 0)).rejects.toThrow(/neither unspent nor present/);
  });
});
