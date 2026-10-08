/**
 * Fulcrum Electrum Protocol Client
 * Connects to Fulcrum server for blockchain queries with connection pooling
 *
 * Failure semantics: every request either resolves with the server's result
 * or rejects. A request in flight on a socket that drops is re-queued once and
 * then rejected; a request that is not answered within the request timeout is
 * rejected and its socket is discarded. Nothing hangs and nothing is silently
 * turned into a fake "success".
 */

import WebSocket from 'ws';
import { createHash } from 'crypto';

interface ElectrumResponse {
  jsonrpc: string;
  id: number | string;
  result?: any;
  error?: {
    code: number;
    message: string;
  };
}

export interface TransactionVerbose {
  txid: string;
  hash: string;
  version: number;
  size: number;
  locktime: number;
  vin: Array<{
    txid: string;
    vout: number;
    scriptSig: { asm: string; hex: string };
    sequence: number;
  }>;
  vout: Array<{
    value: number;
    n: number;
    scriptPubKey: {
      asm: string;
      hex: string;
      type: string;
      addresses?: string[];
    };
  }>;
  blockhash?: string;
  confirmations?: number;
  time?: number;
  blocktime?: number;
}

interface HistoryItem {
  tx_hash: string;
  height: number;
  fee?: number;
}

interface UnspentItem {
  tx_hash: string;
  tx_pos: number;
  height: number;
  value: number;
}

interface PendingRequest {
  id: number;
  method: string;
  params: any[];
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  /** Socket the request was sent on; null while queued */
  ws: WebSocket | null;
  /** Lifetime timer, armed when the request is enqueued */
  timer: NodeJS.Timeout | null;
  /** Number of times the request has been sent */
  attempts: number;
}

/** Default per-request timeout (ms); override with FULCRUM_REQUEST_TIMEOUT_MS */
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
/** Connection open timeout (ms) */
const CONNECT_TIMEOUT_MS = 10000;
/** A request dropped by a closing socket is re-sent at most this many times in total */
const MAX_SEND_ATTEMPTS = 2;
/** Delay before retrying to refill the pool after a failed reconnect (ms) */
const RECONNECT_RETRY_MS = 1000;
/** Largest number of spender candidates fetched in parallel per round */
const MAX_CANDIDATE_ROUND = 16;

/**
 * Process-wide client statistics (survive pool re-creation)
 */
const stats = {
  rpcCalls: 0,          // Requests handed to the pool
  timeouts: 0,          // Requests rejected by the request timeout
  droppedRequests: 0,   // Requests whose socket closed while they were in flight
  connectionsLost: 0,   // Sockets that closed while the pool was active
};

export interface FulcrumStats {
  rpcCalls: number;
  timeouts: number;
  droppedRequests: number;
  connectionsLost: number;
}

export function getFulcrumStats(): FulcrumStats {
  return { ...stats };
}

export function resetFulcrumStats(): void {
  stats.rpcCalls = 0;
  stats.timeouts = 0;
  stats.droppedRequests = 0;
  stats.connectionsLost = 0;
}

export interface FulcrumPoolOptions {
  poolSize?: number;
  requestTimeoutMs?: number;
  wsUrl?: string;
}

/**
 * Connection Pool for Fulcrum WebSocket connections
 */
class FulcrumConnectionPool {
  private connections: WebSocket[] = [];
  private availableConnections: WebSocket[] = [];
  private pendingRequests: Map<number, PendingRequest> = new Map();
  private requestQueue: PendingRequest[] = [];
  private nextRequestId = 1;
  private poolSize: number;
  private wsUrl: string;
  private requestTimeoutMs: number;
  private isClosing = false;
  private refillTimer: NodeJS.Timeout | null = null;

  constructor(options: FulcrumPoolOptions = {}) {
    const wsUrl = options.wsUrl ?? process.env.FULCRUM_WS_URL;
    if (!wsUrl) {
      throw new Error('FULCRUM_WS_URL environment variable is not set');
    }
    this.wsUrl = wsUrl;
    this.poolSize = options.poolSize ?? 10;

    const envTimeout = parseInt(process.env.FULCRUM_REQUEST_TIMEOUT_MS || '', 10);
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_REQUEST_TIMEOUT_MS);
  }

  /**
   * Initialize the connection pool
   * Either every connection opens, or the pool is closed and an error is thrown.
   */
  async initialize(): Promise<void> {
    const results = await Promise.allSettled(
      Array.from({ length: this.poolSize }, () => this.createConnection())
    );

    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failures.length > 0) {
      // Close whatever did open so nothing leaks from a half-built pool
      await this.close();
      const reason = failures[0].reason instanceof Error ? failures[0].reason.message : String(failures[0].reason);
      throw new Error(
        `Failed to open ${failures.length}/${this.poolSize} Fulcrum connections to ${this.wsUrl}: ${reason}`
      );
    }
  }

  /**
   * Create a new WebSocket connection
   */
  private createConnection(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      let opened = false;
      let lastError: Error | null = null;

      const connectTimer = setTimeout(() => {
        ws.terminate();
        reject(new Error('Fulcrum connection timeout during pool initialization'));
      }, CONNECT_TIMEOUT_MS);

      ws.on('open', () => {
        clearTimeout(connectTimer);
        opened = true;
        if (this.isClosing) {
          ws.terminate();
          resolve();
          return;
        }
        this.connections.push(ws);
        this.availableConnections.push(ws);
        this.setupMessageHandler(ws);
        resolve();
        // Requests may have queued up while no socket was available
        this.processQueue();
      });

      ws.on('error', (error) => {
        clearTimeout(connectTimer);
        lastError = error instanceof Error ? error : new Error(String(error));
        if (!opened) {
          reject(lastError);
        }
        // After open, 'close' follows and handles in-flight requests
      });

      ws.on('close', () => {
        clearTimeout(connectTimer);
        if (!opened) {
          reject(lastError ?? new Error('Fulcrum connection closed before it opened'));
          return;
        }
        this.handleConnectionClosed(ws, lastError);
      });
    });
  }

  /**
   * A live socket closed: drop it, deal with its in-flight requests, and refill the pool
   */
  private handleConnectionClosed(ws: WebSocket, lastError: Error | null): void {
    const availableIndex = this.availableConnections.indexOf(ws);
    if (availableIndex !== -1) {
      this.availableConnections.splice(availableIndex, 1);
    }
    const index = this.connections.indexOf(ws);
    if (index !== -1) {
      this.connections.splice(index, 1);
    }

    if (!this.isClosing) {
      stats.connectionsLost++;
    }

    // Requests in flight on this socket will never get a response here.
    // Re-queue each once; reject if it already had its retry or the pool is closing.
    for (const [id, request] of this.pendingRequests) {
      if (request.ws !== ws) continue;
      this.pendingRequests.delete(id);
      request.ws = null;
      stats.droppedRequests++;

      if (!this.isClosing && request.attempts < MAX_SEND_ATTEMPTS) {
        this.requestQueue.unshift(request);
      } else {
        this.settle(
          request,
          new Error(
            `Fulcrum connection closed while ${request.method} was in flight` +
              (lastError ? ` (${lastError.message})` : '')
          )
        );
      }
    }

    this.refillPool();
  }

  /**
   * Open connections until the pool is full again; retry later on failure
   */
  private refillPool(): void {
    if (this.isClosing) return;

    const missing = this.poolSize - this.connections.length;
    if (missing <= 0) return;

    for (let i = 0; i < missing; i++) {
      this.createConnection().catch((err) => {
        console.error('Failed to recreate Fulcrum connection:', err instanceof Error ? err.message : err);
        if (!this.isClosing && !this.refillTimer) {
          this.refillTimer = setTimeout(() => {
            this.refillTimer = null;
            this.refillPool();
          }, RECONNECT_RETRY_MS);
          this.refillTimer.unref();
        }
      });
    }
  }

  /**
   * Setup message handler for a connection
   */
  private setupMessageHandler(ws: WebSocket): void {
    ws.on('message', (data: WebSocket.Data) => {
      let response: ElectrumResponse;
      try {
        response = JSON.parse(data.toString());
      } catch (e) {
        console.error('Error parsing Fulcrum response:', e);
        return;
      }

      const pending = this.pendingRequests.get(Number(response.id));
      if (!pending) {
        // Notification or a response to a request that already timed out
        return;
      }

      this.pendingRequests.delete(pending.id);

      if (response.error) {
        this.settle(pending, new Error(`Fulcrum error: ${response.error.message}`));
      } else {
        this.settle(pending, null, response.result);
      }

      // Mark connection as available and process queue
      if (!this.isClosing && this.connections.includes(ws) && !this.availableConnections.includes(ws)) {
        this.availableConnections.push(ws);
      }
      this.processQueue();
    });
  }

  /**
   * Finish a request exactly once and release its timer
   */
  private settle(request: PendingRequest, error: Error | null, result?: any): void {
    if (request.timer) {
      clearTimeout(request.timer);
      request.timer = null;
    }
    if (error) {
      request.reject(error);
    } else {
      request.resolve(result);
    }
  }

  /**
   * The request's lifetime expired, queued or in flight
   */
  private handleTimeout(request: PendingRequest): void {
    request.timer = null;
    stats.timeouts++;

    const queueIndex = this.requestQueue.indexOf(request);
    if (queueIndex !== -1) {
      this.requestQueue.splice(queueIndex, 1);
    }

    if (this.pendingRequests.has(request.id)) {
      this.pendingRequests.delete(request.id);
      // The socket is stuck or the response is lost; discard it. The 'close'
      // handler finds no pending request for it and simply refills the pool.
      if (request.ws) {
        request.ws.terminate();
      }
    }

    this.settle(
      request,
      new Error(`Fulcrum request ${request.method} timed out after ${this.requestTimeoutMs}ms`)
    );
  }

  /**
   * Make a call using a pooled connection
   */
  call(method: string, params: any[] = []): Promise<any> {
    return new Promise((resolve, reject) => {
      if (this.isClosing) {
        reject(new Error('Fulcrum connection pool is closed'));
        return;
      }

      const request: PendingRequest = {
        id: this.nextRequestId++,
        method,
        params,
        resolve,
        reject,
        ws: null,
        timer: null,
        attempts: 0,
      };
      request.timer = setTimeout(() => this.handleTimeout(request), this.requestTimeoutMs);

      stats.rpcCalls++;
      this.requestQueue.push(request);
      this.processQueue();
    });
  }

  /**
   * Process queued requests
   */
  private processQueue(): void {
    while (this.requestQueue.length > 0 && this.availableConnections.length > 0) {
      const request = this.requestQueue.shift()!;
      const ws = this.availableConnections.shift()!;

      request.ws = ws;
      request.attempts++;
      this.pendingRequests.set(request.id, request);

      const message = {
        jsonrpc: '2.0',
        id: request.id,
        method: request.method,
        params: request.params,
      };

      try {
        ws.send(JSON.stringify(message));
      } catch (error) {
        // If send fails, reject and return connection to pool
        this.pendingRequests.delete(request.id);
        request.ws = null;
        this.settle(request, error instanceof Error ? error : new Error('Failed to send request'));
        this.availableConnections.push(ws);
      }
    }
  }

  /**
   * Get pool statistics
   */
  getStats(): { total: number; available: number; pending: number; queued: number } {
    return {
      total: this.connections.length,
      available: this.availableConnections.length,
      pending: this.pendingRequests.size,
      queued: this.requestQueue.length,
    };
  }

  /**
   * Close all connections; every outstanding request is rejected
   */
  async close(): Promise<void> {
    this.isClosing = true;

    if (this.refillTimer) {
      clearTimeout(this.refillTimer);
      this.refillTimer = null;
    }

    const closedError = new Error('Fulcrum connection pool closed');
    for (const request of this.pendingRequests.values()) {
      this.settle(request, closedError);
    }
    for (const request of this.requestQueue) {
      this.settle(request, closedError);
    }
    this.pendingRequests.clear();
    this.requestQueue = [];

    const sockets = this.connections;
    this.connections = [];
    this.availableConnections = [];
    for (const ws of sockets) {
      ws.terminate();
    }
  }
}

// Global connection pool instance
let globalPool: FulcrumConnectionPool | null = null;
// In-progress initialisation shared by concurrent first callers
let globalPoolInit: Promise<FulcrumConnectionPool> | null = null;

/**
 * Get or create the global connection pool
 * The pool is only published once every connection is open; a failed
 * initialisation is discarded so the next call retries from scratch.
 */
export async function getConnectionPool(poolSize = 10): Promise<FulcrumConnectionPool> {
  if (globalPool) {
    return globalPool;
  }

  if (!globalPoolInit) {
    globalPoolInit = (async () => {
      const pool = new FulcrumConnectionPool({ poolSize });
      try {
        await pool.initialize();
      } catch (error) {
        globalPoolInit = null;
        throw error;
      }
      globalPool = pool;
      return pool;
    })();
  }

  return globalPoolInit;
}

/**
 * Close the global connection pool
 */
export async function closeConnectionPool(): Promise<void> {
  const pool = globalPool;
  globalPool = null;
  globalPoolInit = null;
  if (pool) {
    await pool.close();
  }
}

/**
 * Make a call to Fulcrum using the connection pool
 */
async function electrumCall(method: string, params: any[] = []): Promise<any> {
  const pool = await getConnectionPool();
  return pool.call(method, params);
}

/**
 * Calculate Electrum scripthash from scriptPubKey hex
 * Scripthash = sha256(scriptPubKey) reversed as hex
 */
export function calculateScripthash(scriptPubKeyHex: string): string {
  const scriptBuffer = Buffer.from(scriptPubKeyHex, 'hex');
  const hash = createHash('sha256').update(scriptBuffer).digest();
  // Reverse the hash bytes
  return hash.reverse().toString('hex');
}

/**
 * Get transaction in verbose format (with decoded inputs/outputs)
 */
export async function getTransaction(txid: string): Promise<TransactionVerbose> {
  const result = await electrumCall('blockchain.transaction.get', [txid, true]);
  return result as TransactionVerbose;
}

/**
 * Get transaction as raw hex
 */
export async function getTransactionHex(txid: string): Promise<string> {
  const result = await electrumCall('blockchain.transaction.get', [txid, false]);
  return result as string;
}

/**
 * Get history for a scripthash (all transactions involving this script)
 * Used to find which transaction spent an output
 */
export async function getScripthashHistory(scripthash: string): Promise<HistoryItem[]> {
  const result = await electrumCall('blockchain.scripthash.get_history', [scripthash]);
  return result as HistoryItem[];
}

/**
 * Get the unspent outputs of a scripthash (confirmed and mempool)
 *
 * BCMR authhead outputs frequently carry CashTokens, and Fulcrum excludes
 * token-bearing UTXOs from `listunspent` unless asked for them, so the
 * `include_tokens` filter is always requested (Fulcrum >= 1.9.0).
 */
export async function getScripthashUnspent(scripthash: string): Promise<UnspentItem[]> {
  const result = await electrumCall('blockchain.scripthash.listunspent', [scripthash, 'include_tokens']);
  return result as UnspentItem[];
}

/**
 * Check if a specific output (txid:vout) is spent
 * Returns the spending transaction hash if spent, null if unspent
 *
 * Fast path: one `listunspent` call answers "still unspent" (the common case).
 * Only when the outpoint is missing from the unspent set is the script history
 * walked to find the spending transaction.
 *
 * Errors propagate. An unanswered question must never be reported as "unspent",
 * because callers treat null as "this is the authhead".
 */
export async function getOutputSpendingTx(
  txid: string,
  vout: number
): Promise<string | null> {
  // Get the transaction to find output's scriptPubKey
  const tx = await getTransaction(txid);
  const output = tx?.vout?.[vout];

  if (!output) {
    throw new Error(`Output ${vout} does not exist in transaction ${txid}`);
  }

  const scriptPubKeyHex = output.scriptPubKey.hex;

  // OP_RETURN outputs are provably unspendable (and not in the UTXO index)
  if (scriptPubKeyHex.startsWith('6a')) {
    return null;
  }

  const scripthash = calculateScripthash(scriptPubKeyHex);

  // Fast path: is the outpoint still in the unspent set?
  const unspent = await getScripthashUnspent(scripthash);
  if (unspent.some((u) => u.tx_hash === txid && Number(u.tx_pos) === vout)) {
    return null;
  }

  // Slow path: the outpoint is spent; find the spender in the script history.
  // Electrum history is in chronological order, so the spender follows our tx.
  const history = await getScripthashHistory(scripthash);
  const ourTxIndex = history.findIndex((h) => h.tx_hash === txid);

  if (ourTxIndex === -1) {
    throw new Error(
      `Transaction ${txid} is neither unspent nor present in the history of its output ${vout} script (not indexed yet?)`
    );
  }

  const candidates = [
    ...history.slice(ourTxIndex + 1),
    ...history.slice(0, ourTxIndex), // defensive: unexpected ordering
  ];

  // The spender is usually the very next entry, but on a busy address it can
  // be hundreds of entries away. Fetch candidates in rounds that double in
  // size so short scans waste nothing and long scans use the whole pool.
  let roundSize = 1;
  let next = 0;
  while (next < candidates.length) {
    const round = candidates.slice(next, next + roundSize);
    const txs = await Promise.all(round.map((c) => getTransaction(c.tx_hash)));
    for (let j = 0; j < txs.length; j++) {
      if (txs[j].vin.some((input) => input.txid === txid && input.vout === vout)) {
        return round[j].tx_hash;
      }
    }
    next += round.length;
    roundSize = Math.min(roundSize * 2, MAX_CANDIDATE_ROUND);
  }

  throw new Error(
    `Output ${txid}:${vout} is not unspent, but no spending transaction was found in its script history`
  );
}

/**
 * Get server information
 */
export async function getServerInfo(): Promise<{
  version: string;
  protocolVersion: string;
  blockHeight: number;
}> {
  const serverVersion = await electrumCall('server.version', ['BCMR Client', '1.4']);
  const headerSubscription = await electrumCall('blockchain.headers.subscribe');

  return {
    version: Array.isArray(serverVersion) ? serverVersion[0] : serverVersion,
    protocolVersion: Array.isArray(serverVersion) ? serverVersion[1] : 'unknown',
    blockHeight: headerSubscription?.height || 0,
  };
}
