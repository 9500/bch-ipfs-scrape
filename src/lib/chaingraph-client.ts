/**
 * Chaingraph GraphQL client for authchain resolution
 *
 * Chaingraph can answer the two questions a walk asks ("who spent output 0 of
 * this transaction?" and "which output does input 0 spend?") for a whole batch
 * of transactions in one request, and it can resolve an entire authchain
 * server-side (`transaction.authchains`). Lookups issued by concurrent walks in
 * the same tick are collected into one request by a small batcher.
 *
 * Every request either returns the server's answer or rejects; a transaction
 * that Chaingraph does not know is an error, never "unspent".
 */

import type { AuthchainBackend, ChainResolution } from './bcmr.js';

/** Default request timeout (ms); override with CHAINGRAPH_TIMEOUT_MS */
const DEFAULT_TIMEOUT_MS = 120000;
/** Batch sizes per query kind */
const SPEND_BATCH = 200;
const PARENT_BATCH = 200;
/** authchains is a recursive query on the server; keep these batches small */
const CHAIN_BATCH = 10;
/** Batch size for embedding resolution data into a Chaingraph result file */
const EMBED_BATCH = 50;

/**
 * Process-wide client statistics (survive client re-creation)
 */
const stats = {
  requests: 0,      // GraphQL requests sent
  failures: 0,      // Requests that failed (HTTP, GraphQL or timeout)
  spendLookups: 0,  // Output-0 spend answers returned
  parentLookups: 0, // Input-0 outpoint answers returned
  chainLookups: 0,  // Server-side authchain resolutions returned
};

export type ChaingraphStats = typeof stats;

export function getChaingraphStats(): ChaingraphStats {
  return { ...stats };
}

export function resetChaingraphStats(): void {
  for (const key of Object.keys(stats) as Array<keyof ChaingraphStats>) {
    stats[key] = 0;
  }
}

export interface ChaingraphClientOptions {
  url?: string;
  timeoutMs?: number;
}

/** Chaingraph (PostgreSQL) hex: "\x" + hex */
export function toBytea(hex: string): string {
  return '\\x' + hex;
}

/** Strip the "\x" prefix Chaingraph puts on hex values */
export function fromBytea(value: string): string {
  return value.startsWith('\\x') ? value.slice(2) : value;
}

function resolveUrl(options?: ChaingraphClientOptions): string {
  const url = options?.url ?? process.env.CHAINGRAPH_URL;
  if (!url) {
    throw new Error('CHAINGRAPH_URL environment variable is not set');
  }
  return url;
}

function resolveTimeout(options?: ChaingraphClientOptions): number {
  if (options?.timeoutMs) return options.timeoutMs;
  const env = parseInt(process.env.CHAINGRAPH_TIMEOUT_MS || '', 10);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_TIMEOUT_MS;
}

/**
 * Send one GraphQL query and return its `data`
 */
export async function chaingraphQuery<T>(
  query: string,
  variables: Record<string, unknown> | undefined,
  options?: ChaingraphClientOptions
): Promise<T> {
  const url = resolveUrl(options);
  const timeoutMs = resolveTimeout(options);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  stats.requests++;

  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Chaingraph request timed out after ${timeoutMs}ms`);
      }
      throw new Error(`Chaingraph request failed: ${error instanceof Error ? error.message : error}`);
    }

    if (!response.ok) {
      throw new Error(`Chaingraph request failed: ${response.status} ${response.statusText}`);
    }

    const body = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (body.errors && body.errors.length > 0) {
      throw new Error(`Chaingraph GraphQL error: ${body.errors.map((e) => e.message).join('; ')}`);
    }
    if (!body.data) {
      throw new Error('Chaingraph response has no data');
    }
    return body.data;
  } catch (error) {
    stats.failures++;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

interface Waiter<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

/**
 * Collects keys requested in the same tick and answers them with one query per chunk
 */
class Batcher<T> {
  private waiters = new Map<string, Array<Waiter<T>>>();
  private scheduled = false;

  constructor(
    private readonly maxBatch: number,
    private readonly run: (keys: string[]) => Promise<Map<string, T>>,
    private readonly describeMissing: (key: string) => string
  ) {}

  get(key: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const list = this.waiters.get(key);
      if (list) {
        list.push({ resolve, reject });
      } else {
        this.waiters.set(key, [{ resolve, reject }]);
      }
      if (!this.scheduled) {
        this.scheduled = true;
        // A macrotask boundary lets every walk that resumed from the previous
        // batch response enqueue its next hop before the batch is sent.
        setTimeout(() => this.flush(), 0);
      }
    });
  }

  private async flush(): Promise<void> {
    this.scheduled = false;
    const pending = this.waiters;
    this.waiters = new Map();
    const keys = Array.from(pending.keys());

    for (let i = 0; i < keys.length; i += this.maxBatch) {
      const chunk = keys.slice(i, i + this.maxBatch);
      let results: Map<string, T> | null = null;
      let failure: Error | null = null;
      try {
        results = await this.run(chunk);
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
      }

      for (const key of chunk) {
        const waiters = pending.get(key) ?? [];
        if (failure) {
          for (const w of waiters) w.reject(failure);
        } else if (results && results.has(key)) {
          const value = results.get(key) as T;
          for (const w of waiters) w.resolve(value);
        } else {
          const error = new Error(this.describeMissing(key));
          for (const w of waiters) w.reject(error);
        }
      }
    }
  }
}

interface SpendRow {
  transaction_hash: string;
  spent_by: Array<{ transaction: { hash: string } }>;
}

interface ParentRow {
  hash: string;
  inputs: Array<{ outpoint_transaction_hash: string }>;
}

export interface AuthchainRow {
  authhead_transaction_hash: string;
  authchain_length: number | string;
  unspent_authhead: boolean;
}

interface ChainRow {
  hash: string;
  authchains: AuthchainRow[];
}

const SPEND_QUERY = `query ($h: [bytea!]) {
  output(where: {transaction_hash: {_in: $h}, output_index: {_eq: "0"}}) {
    transaction_hash
    spent_by { transaction { hash } }
  }
}`;

const PARENT_QUERY = `query ($h: [bytea!]) {
  transaction(where: {hash: {_in: $h}}) {
    hash
    inputs(where: {input_index: {_eq: "0"}}) { outpoint_transaction_hash }
  }
}`;

const CHAIN_QUERY = `query ($h: [bytea!]) {
  transaction(where: {hash: {_in: $h}}) {
    hash
    authchains { authhead_transaction_hash authchain_length unspent_authhead }
  }
}`;

/** Query used to embed resolution data into a Chaingraph result file */
const EMBED_QUERY = `query ($h: [bytea!]) {
  transaction(where: {hash: {_in: $h}}) {
    hash
    authchains { authhead_transaction_hash authchain_length unspent_authhead }
    inputs(where: {input_index: {_eq: "0"}}) { outpoint_transaction_hash outpoint_index }
  }
}`;

/**
 * Convert a Chaingraph authchain row into the resolution shape used by the walk
 */
export function chainResolutionFromRow(row: AuthchainRow): ChainResolution {
  return {
    authhead: fromBytea(row.authhead_transaction_hash),
    chainLength: Number(row.authchain_length),
    isActive: Boolean(row.unspent_authhead),
  };
}

/**
 * Create a resolution backend that answers from Chaingraph
 */
export function createChaingraphBackend(options?: ChaingraphClientOptions): AuthchainBackend {
  const url = resolveUrl(options);
  const clientOptions = { ...options, url };
  const started = getChaingraphStats();

  const spends = new Batcher<string | null>(
    SPEND_BATCH,
    async (txids) => {
      const data = await chaingraphQuery<{ output: SpendRow[] }>(SPEND_QUERY, { h: txids.map(toBytea) }, clientOptions);
      const map = new Map<string, string | null>();
      for (const row of data.output) {
        // An output has at most one spender on the main chain; Chaingraph
        // lists it first if a conflicting unconfirmed spend was ever seen.
        const spender = row.spent_by[0]?.transaction?.hash;
        map.set(fromBytea(row.transaction_hash), spender ? fromBytea(spender) : null);
      }
      stats.spendLookups += map.size;
      return map;
    },
    (txid) => `Transaction ${txid} (output 0) is not known to Chaingraph`
  );

  const parents = new Batcher<string | null>(
    PARENT_BATCH,
    async (txids) => {
      const data = await chaingraphQuery<{ transaction: ParentRow[] }>(PARENT_QUERY, { h: txids.map(toBytea) }, clientOptions);
      const map = new Map<string, string | null>();
      for (const row of data.transaction) {
        const outpoint = row.inputs[0]?.outpoint_transaction_hash;
        map.set(fromBytea(row.hash), outpoint ? fromBytea(outpoint) : null);
      }
      stats.parentLookups += map.size;
      return map;
    },
    (txid) => `Transaction ${txid} is not known to Chaingraph`
  );

  const chains = new Batcher<ChainResolution>(
    CHAIN_BATCH,
    async (txids) => {
      const data = await chaingraphQuery<{ transaction: ChainRow[] }>(CHAIN_QUERY, { h: txids.map(toBytea) }, clientOptions);
      const map = new Map<string, ChainResolution>();
      for (const row of data.transaction) {
        if (row.authchains[0]) {
          map.set(fromBytea(row.hash), chainResolutionFromRow(row.authchains[0]));
        }
      }
      stats.chainLookups += map.size;
      return map;
    },
    (txid) => `Chaingraph returned no authchain for transaction ${txid}`
  );

  return {
    name: `chaingraph (${url})`,
    getSpendingTx: (txid) => spends.get(txid),
    getParentTxId: (txid) => parents.get(txid),
    resolveChain: (txid) => chains.get(txid),
    getStats: () => {
      const now = getChaingraphStats();
      return {
        'Chaingraph requests': now.requests - started.requests,
        'Chaingraph failed requests': now.failures - started.failures,
        'Chaingraph spend answers': now.spendLookups - started.spendLookups,
        'Chaingraph parent answers': now.parentLookups - started.parentLookups,
        'Chaingraph server-side chain resolutions': now.chainLookups - started.chainLookups,
      };
    },
  };
}

/** Rows per page when fetching BCMR outputs; Chaingraph caps a request at 5000 rows */
const OUTPUT_PAGE_SIZE = 1000;

/**
 * Default query for BCMR outputs, one page at a time. Chaingraph (Hasura) silently
 * truncates a single request to 5000 rows, so pages are fetched in a stable order
 * until a short page is returned.
 */
const BCMR_OUTPUTS_PAGE_QUERY = `query BCMROutputsPage($limit: Int!, $offset: Int!) {
  search_output_prefix(
    args: { locking_bytecode_prefix_hex: "6a0442434d5220" }
    order_by: { transaction_hash: asc, output_index: asc }
    limit: $limit
    offset: $offset
  ) {
    locking_bytecode
    output_index
    transaction_hash
    value_satoshis
    transaction {
      block_inclusions {
        block {
          hash
          height
        }
      }
    }
    spent_by {
      input_index
      transaction {
        hash
        block_inclusions {
          block {
            hash
            height
          }
        }
      }
    }
  }
}`;

/**
 * Fetch every BCMR OP_RETURN output known to Chaingraph (all pages)
 */
export async function fetchBCMROutputs<T extends { transaction_hash: string }>(
  options?: ChaingraphClientOptions & { pageSize?: number; onPage?: (fetched: number) => void }
): Promise<T[]> {
  const url = resolveUrl(options);
  const clientOptions = { url, timeoutMs: options?.timeoutMs };
  const pageSize = options?.pageSize ?? OUTPUT_PAGE_SIZE;
  const rows: T[] = [];

  for (let offset = 0; ; offset += pageSize) {
    const data = await chaingraphQuery<{ search_output_prefix: T[] }>(
      BCMR_OUTPUTS_PAGE_QUERY,
      { limit: pageSize, offset },
      clientOptions
    );
    const page = data.search_output_prefix ?? [];
    rows.push(...page);
    options?.onPage?.(rows.length);
    if (page.length < pageSize) {
      break;
    }
  }
  return rows;
}

/**
 * Minimal shape of a Chaingraph result row that embedding writes into
 */
export interface EmbeddableRow {
  transaction_hash: string;
  transaction?: {
    authchains?: AuthchainRow[];
    inputs?: Array<{ outpoint_transaction_hash: string; outpoint_index?: string | number }>;
    [key: string]: unknown;
  };
}

/**
 * Outcome of embedding resolution data into a result file
 */
export interface EmbedResult {
  embedded: number; // Rows that received resolution data
  unspent: number;  // Transactions whose output 0 is unspent (chain of length 1, no server recursion)
  resolved: number; // Transactions resolved by Chaingraph's recursive authchains query
  failed: number;   // Transactions Chaingraph could not resolve (left without data)
}

/**
 * Fetch authchain resolution and the input-0 outpoint for every transaction in
 * `rows` and store them on each row's `transaction` object, so a consumer of
 * the result file can resolve registries without any blockchain access.
 *
 * Cheap batched queries answer "is output 0 still unspent?" and "what does
 * input 0 spend?" for every transaction. Only transactions whose output 0 is
 * spent need Chaingraph's recursive `authchains` query, which can take tens of
 * seconds for chains that drifted into busy wallets; a batch that fails is
 * split in half down to single transactions, and a transaction that still
 * fails is skipped and counted.
 */
export async function embedResolution(
  rows: EmbeddableRow[],
  options?: ChaingraphClientOptions & { onProgress?: (phase: string, done: number, total: number) => void }
): Promise<EmbedResult> {
  const url = resolveUrl(options);
  const clientOptions = { url, timeoutMs: options?.timeoutMs };
  const hashes = Array.from(new Set(rows.map((r) => fromBytea(r.transaction_hash))));
  const result: EmbedResult = { embedded: 0, unspent: 0, resolved: 0, failed: 0 };

  // Phase 1: spend status of output 0 and input-0 outpoint, cheap and batched
  const spentBy = new Map<string, string | null>();
  const parents = new Map<string, string | null>();
  for (let i = 0; i < hashes.length; i += SPEND_BATCH) {
    const batch = hashes.slice(i, i + SPEND_BATCH).map(toBytea);
    const [spendData, parentData] = await Promise.all([
      chaingraphQuery<{ output: SpendRow[] }>(SPEND_QUERY, { h: batch }, clientOptions),
      chaingraphQuery<{ transaction: ParentRow[] }>(PARENT_QUERY, { h: batch }, clientOptions),
    ]);
    for (const row of spendData.output) {
      const spender = row.spent_by[0]?.transaction?.hash;
      spentBy.set(fromBytea(row.transaction_hash), spender ? fromBytea(spender) : null);
    }
    for (const row of parentData.transaction) {
      const outpoint = row.inputs[0]?.outpoint_transaction_hash;
      parents.set(fromBytea(row.hash), outpoint ? fromBytea(outpoint) : null);
    }
    options?.onProgress?.('Spend status', Math.min(i + SPEND_BATCH, hashes.length), hashes.length);
  }

  // Phase 2: recursive resolution, only for transactions whose output 0 is spent
  const chains = new Map<string, AuthchainRow>();
  for (const hash of hashes) {
    if (spentBy.has(hash) && spentBy.get(hash) === null) {
      chains.set(hash, { authhead_transaction_hash: toBytea(hash), authchain_length: 1, unspent_authhead: true });
      result.unspent++;
    }
  }
  const needResolution = hashes.filter((h) => spentBy.has(h) && spentBy.get(h) !== null);

  const resolveBatch = async (batch: string[]): Promise<void> => {
    try {
      const data = await chaingraphQuery<{ transaction: ChainRow[] }>(CHAIN_QUERY, { h: batch.map(toBytea) }, clientOptions);
      for (const row of data.transaction) {
        if (row.authchains[0]) {
          chains.set(fromBytea(row.hash), row.authchains[0]);
          result.resolved++;
        }
      }
    } catch (error) {
      if (batch.length === 1) {
        result.failed++;
        console.warn(`Warning: Chaingraph could not resolve the authchain of ${batch[0]}: ${error instanceof Error ? error.message : error}`);
        return;
      }
      // Too slow or too big as a whole; try the halves
      const half = Math.ceil(batch.length / 2);
      await resolveBatch(batch.slice(0, half));
      await resolveBatch(batch.slice(half));
    }
  };

  let done = 0;
  for (let i = 0; i < needResolution.length; i += EMBED_BATCH) {
    const batch = needResolution.slice(i, i + EMBED_BATCH);
    await resolveBatch(batch);
    done += batch.length;
    options?.onProgress?.('Server-side resolution', done, needResolution.length);
  }

  for (const row of rows) {
    const hash = fromBytea(row.transaction_hash);
    const chain = chains.get(hash);
    if (!chain) continue;
    row.transaction = row.transaction ?? {};
    row.transaction.authchains = [chain];
    const parent = parents.get(hash);
    row.transaction.inputs = parent ? [{ outpoint_transaction_hash: toBytea(parent), outpoint_index: '0' }] : [];
    result.embedded++;
  }
  // Transactions Chaingraph did not return in phase 1 are unknown to it
  result.failed += hashes.filter((h) => !spentBy.has(h)).length;
  return result;
}
