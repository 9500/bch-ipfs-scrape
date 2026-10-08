/**
 * Fake Fulcrum (Electrum protocol over WebSocket) for tests.
 *
 * Answers from a recorded fixture: blockchain.transaction.get (verbose),
 * blockchain.scripthash.listunspent, blockchain.scripthash.get_history,
 * server.version and blockchain.headers.subscribe. Anything not in the
 * fixture is a JSON-RPC error, so a walk that needs unrecorded data fails
 * loudly instead of silently looking "unspent".
 *
 * Failure injection (`behaviour`) lets tests exercise socket drops,
 * unanswered requests and RPC errors against the real client.
 */
import { WebSocketServer, type WebSocket, type RawData } from 'ws';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';

export interface FulcrumFixture {
  transactions: Record<string, unknown>;
  listunspent: Record<string, unknown[]>;
  history: Record<string, unknown[]>;
}

export type FakeBehaviour =
  /** Normal answer from the fixture */
  | { kind: 'answer' }
  /** Close the socket instead of answering */
  | { kind: 'drop' }
  /** Never answer */
  | { kind: 'ignore' }
  /** JSON-RPC error with this message */
  | { kind: 'error'; message: string };

export interface FakeFulcrum {
  url: string;
  /** Every request received, in order */
  requests: Array<{ method: string; params: unknown[] }>;
  /** Decide per request; defaults to answering from the fixture */
  behaviour: (method: string, params: unknown[]) => FakeBehaviour;
  close: () => Promise<void>;
}

export function loadFulcrumFixture(path: string): FulcrumFixture {
  return JSON.parse(readFileSync(path, 'utf-8')) as FulcrumFixture;
}

export async function startFakeFulcrum(fixture: FulcrumFixture): Promise<FakeFulcrum> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => wss.once('listening', resolve));

  const fake: FakeFulcrum = {
    url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
    requests: [],
    behaviour: () => ({ kind: 'answer' }),
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };

  const answer = (method: string, params: unknown[]): { result: unknown } | { error: string } => {
    switch (method) {
      case 'server.version':
        return { result: ['Fake Fulcrum 0.0', '1.4'] };
      case 'blockchain.headers.subscribe':
        return { result: { height: 1, hex: '' } };
      case 'blockchain.transaction.get': {
        const tx = fixture.transactions[String(params[0])];
        return tx ? { result: tx } : { error: `No such mempool or blockchain transaction: ${params[0]}` };
      }
      case 'blockchain.scripthash.listunspent': {
        const list = fixture.listunspent[String(params[0])];
        return list ? { result: list } : { error: `scripthash not in fixture: ${params[0]}` };
      }
      case 'blockchain.scripthash.get_history': {
        const list = fixture.history[String(params[0])];
        return list ? { result: list } : { error: `scripthash history not in fixture: ${params[0]}` };
      }
      default:
        return { error: `unknown method ${method}` };
    }
  };

  wss.on('connection', (ws: WebSocket) => {
    ws.on('message', (data: RawData) => {
      const { id, method, params } = JSON.parse(data.toString());
      fake.requests.push({ method, params });
      const behaviour = fake.behaviour(method, params);
      if (behaviour.kind === 'drop') {
        ws.terminate();
        return;
      }
      if (behaviour.kind === 'ignore') {
        return;
      }
      const reply = behaviour.kind === 'error' ? { error: behaviour.message } : answer(method, params);
      if ('error' in reply) {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: reply.error } }));
      } else {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, result: reply.result }));
      }
    });
  });

  return fake;
}
