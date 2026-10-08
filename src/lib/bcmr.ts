/**
 * BCMR (Bitcoin Cash Metadata Registries) Library
 * Fetches and parses BCMR registry announcements from the BCH blockchain
 */

import { getOutputSpendingTx, getTransaction, getFulcrumStats } from './fulcrum-client.js';
import { createChaingraphBackend, chainResolutionFromRow, fetchBCMROutputs, fromBytea, type AuthchainRow } from './chaingraph-client.js';
import { createHash } from 'crypto';
import type { AuthchainCache, AuthchainCacheEntry } from './authchain-cache.js';
import {
  loadAuthchainCache,
  saveAuthchainCache,
  createEmptyCache,
  getCacheStats,
} from './authchain-cache.js';
import { validateBCMRSchema } from './schema-validator.js';
import { isInternalHostname, safeFetch } from './ssrf.js';

export interface BCMROutput {
  locking_bytecode: string;
  output_index: string | number; // Chaingraph returns as string
  transaction_hash: string;
  value_satoshis: string | number; // Chaingraph returns as string
  transaction: {
    block_inclusions: Array<{
      block: {
        hash: string;
        height: string | number; // Chaingraph returns as string
      };
    }>;
    /** Present when the result file was produced with embedded resolution */
    authchains?: AuthchainRow[];
    inputs?: Array<{ outpoint_transaction_hash: string; outpoint_index?: string | number }>;
  };
  spent_by: Array<{
    input_index: string | number; // Chaingraph returns as string
    transaction: {
      hash: string;
      block_inclusions: Array<{
        block: {
          hash: string;
          height: string | number; // Chaingraph returns as string
        };
      }>;
    };
  }>;
}

interface ParsedBCMR {
  hash: string;
  uris: string[];
}

/**
 * One BCMR announcement, annotated with the identity (authchain) it belongs to.
 * An identity updated N times yields N entries sharing authbase/authhead/tokenId;
 * exactly one of them has `isSuperseded === false` and carries the current registry.
 */
export interface BCMRRegistry {
  authbase: string; // Earliest BCMR announcement of this identity (start of the authchain)
  authhead: string; // Current head of the authchain (transaction holding the unspent output 0)
  tokenId: string;  // vin[0].txid of the authbase (CashToken category ID when the authbase is the genesis)
  blockHeight: number; // Block height of this announcement's transaction
  hash: string;
  uris: string[];
  isBurned: boolean;
  isValid: boolean;
  authchainLength: number; // Number of transactions from authbase to authhead (inclusive)
  isAuthheadUnspent: boolean; // True if authhead output 0 is unspent (active registry)
  isSuperseded: boolean; // True if a later announcement on the same authchain replaces this one
  resolutionError: string | null; // Set when the authchain walk failed; the authhead is then unknown
}

/**
 * Gateway configuration for IPFS URL rewriting
 */
export interface GatewayConfig {
  defaultGateway: string;           // "host[:port]" (https) or "http://host[:port]"
  rewriteAllGateways: boolean;      // Enable global rewrite
  targetGateway: string | null;     // Target for global rewrite, same format as defaultGateway
  gatewayMapping: Map<string, string> | null;  // source host -> destination gateway (same format)
}

/**
 * Base URL of a user-configured gateway: an explicit http:// is honoured,
 * anything else is reached over https.
 */
export function gatewayBaseUrl(gateway: string): string {
  return /^http:\/\//i.test(gateway) ? gateway : `https://${gateway}`;
}

/**
 * Strip PostgreSQL hex prefix (\x) from hex strings
 */
function stripHexPrefix(hex: string): string {
  // Handle both \x and \\x prefixes from PostgreSQL
  if (hex.startsWith('\\x')) {
    return hex.slice(2);
  }
  if (hex.startsWith('0x')) {
    return hex.slice(2);
  }
  return hex;
}

/**
 * Maximum allowed URL length (characters)
 * Conservative limit to prevent abuse and ensure compatibility
 */
const MAX_URL_LENGTH = 2048;

/**
 * Validate URL contains only valid characters per RFC 3986 and is within length limit
 * Rejects URLs with control characters, null bytes, or other invalid content
 *
 * Valid characters:
 * - Alphanumeric: a-z A-Z 0-9
 * - Unreserved: - . _ ~
 * - Reserved: : / ? # [ ] @ ! $ & ' ( ) * + , ; = %
 *
 * @param url - URL string to validate
 * @returns true if URL contains only valid characters and is within length limit
 */
export function isValidUrlCharacters(url: string): boolean {
  // Check length limit
  if (url.length === 0 || url.length > MAX_URL_LENGTH) {
    return false;
  }

  // RFC 3986 compliant character set
  // This rejects control characters, null bytes, and other binary garbage
  const validUrlPattern = /^[a-zA-Z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+$/;
  return validUrlPattern.test(url);
}

/**
 * Parse BCMR locking bytecode to extract hash and URIs
 */
function parseBCMRBytecode(hex: string): ParsedBCMR | null {
  try {
    // Strip PostgreSQL hex prefix if present
    const cleanHex = stripHexPrefix(hex);
    const bytes = Buffer.from(cleanHex, 'hex');
    let pos = 0;

    // Verify OP_RETURN (0x6a)
    if (bytes[pos] !== 0x6a) return null;
    pos++;

    // Verify OP_PUSHBYTES_4 (0x04) and "BCMR"
    if (bytes[pos] !== 0x04) return null;
    pos++;

    const bcmrText = bytes.slice(pos, pos + 4).toString('ascii');
    if (bcmrText !== 'BCMR') return null;
    pos += 4;

    // Verify OP_PUSHBYTES_32 (0x20) for hash
    if (bytes[pos] !== 0x20) return null;
    pos++;

    // Extract 32-byte SHA-256 hash
    const hash = bytes.slice(pos, pos + 32).toString('hex');
    pos += 32;

    // Extract URIs (remaining push operations)
    const uris: string[] = [];

    while (pos < bytes.length) {
      const opcode = bytes[pos];
      pos++;

      let pushLength = 0;

      if (opcode >= 0x01 && opcode <= 0x4b) {
        // Direct push (1-75 bytes)
        pushLength = opcode;
      } else if (opcode === 0x4c) {
        // OP_PUSHDATA1
        pushLength = bytes[pos];
        pos++;
      } else if (opcode === 0x4d) {
        // OP_PUSHDATA2
        pushLength = bytes.readUInt16LE(pos);
        pos += 2;
      } else if (opcode === 0x4e) {
        // OP_PUSHDATA4
        pushLength = bytes.readUInt32LE(pos);
        pos += 4;
      } else {
        // Unknown opcode, skip
        break;
      }

      if (pos + pushLength > bytes.length) break;

      const uriBytes = bytes.slice(pos, pos + pushLength);
      try {
        const uri = uriBytes.toString('utf8').trim();
        // Validate URI: must be non-empty and contain only valid URL characters
        // This filters out malformed URLs with control characters, null bytes, etc.
        if (uri.length > 0 && isValidUrlCharacters(uri)) {
          uris.push(uri);
        }
      } catch (e) {
        // Invalid UTF-8, skip this URI
      }

      pos += pushLength;
    }

    return { hash, uris };
  } catch (error) {
    console.error('Error parsing BCMR bytecode:', error);
    return null;
  }
}

/**
 * Filter to keep only the first BCMR output per transaction
 */
function filterFirstOutputOnly(outputs: BCMROutput[]): BCMROutput[] {
  const txMap = new Map<string, BCMROutput>();

  for (const output of outputs) {
    const txHash = stripHexPrefix(output.transaction_hash);
    const existing = txMap.get(txHash);
    const currentIndex = parseInt(String(output.output_index));
    const existingIndex = existing ? parseInt(String(existing.output_index)) : Infinity;

    if (!existing || currentIndex < existingIndex) {
      txMap.set(txHash, output);
    }
  }

  return Array.from(txMap.values());
}

/**
 * Check if an output is burned (is OP_RETURN at output index 0)
 */
function isOutputBurned(output: BCMROutput): boolean {
  // An identity is burned if the authhead transaction's output 0 is OP_RETURN
  // For simplicity, we check if this output is at index 0 and is OP_RETURN
  const outputIndex = parseInt(String(output.output_index));
  return outputIndex === 0;
}

/**
 * Result of resolving a whole authchain in one step (server-side)
 */
export interface ChainResolution {
  authhead: string;
  chainLength: number; // Transactions from the queried tx to the authhead, inclusive
  isActive: boolean;   // Whether the authhead's output 0 is unspent
}

/**
 * Source of blockchain answers for authchain resolution.
 * Implemented by the Fulcrum client and the Chaingraph client; tests inject fakes.
 */
export interface AuthchainBackend {
  /** Human-readable name for the run summary */
  name: string;
  /** Return the txid spending output 0 of `txid`, or null if that output is unspent */
  getSpendingTx: (txid: string) => Promise<string | null>;
  /** Return the txid spent by input 0 of `txid` (the token category for a genesis), or null if none */
  getParentTxId: (txid: string) => Promise<string | null>;
  /** Optional: resolve the whole chain starting at `txid` in one call */
  resolveChain?: (txid: string) => Promise<ChainResolution>;
  /** Optional: counters for the run summary */
  getStats?: () => Record<string, number>;
}

/**
 * Resolution backend answering from Fulcrum
 */
export function createFulcrumBackend(): AuthchainBackend {
  const started = getFulcrumStats();
  return {
    name: `fulcrum (${process.env.FULCRUM_WS_URL ?? 'FULCRUM_WS_URL'})`,
    getSpendingTx: (txid) => getOutputSpendingTx(txid, 0),
    getParentTxId: async (txid) => {
      const tx = await getTransaction(txid);
      // Coinbase inputs have no previous output
      return tx.vin && tx.vin.length > 0 && tx.vin[0].txid ? tx.vin[0].txid : null;
    },
    getStats: () => {
      const now = getFulcrumStats();
      return {
        'Electrum RPC calls': now.rpcCalls - started.rpcCalls,
        'Fulcrum timeouts': now.timeouts - started.timeouts,
        'Fulcrum dropped requests': now.droppedRequests - started.droppedRequests,
        'Fulcrum connections lost': now.connectionsLost - started.connectionsLost,
      };
    },
  };
}

/**
 * Use `primary` and fall back to `secondary` for any lookup the primary fails
 */
export function withFallback(primary: AuthchainBackend, secondary: AuthchainBackend): AuthchainBackend {
  let fallbacks = 0;
  let warned = false;
  const fallback = async <T>(what: string, txid: string, first: () => Promise<T>, second: () => Promise<T>): Promise<T> => {
    try {
      return await first();
    } catch (error) {
      fallbacks++;
      if (!warned) {
        warned = true;
        console.warn(
          `Warning: ${primary.name} failed for ${what} ${txid} (${error instanceof Error ? error.message : error}); falling back to ${secondary.name}`
        );
      }
      return second();
    }
  };
  return {
    name: `${primary.name} with fallback to ${secondary.name}`,
    getSpendingTx: (txid) => fallback('spend lookup', txid, () => primary.getSpendingTx(txid), () => secondary.getSpendingTx(txid)),
    getParentTxId: (txid) => fallback('parent lookup', txid, () => primary.getParentTxId(txid), () => secondary.getParentTxId(txid)),
    // Only the primary can resolve whole chains; a failure falls back to walking
    resolveChain: primary.resolveChain,
    getStats: () => ({
      ...(primary.getStats?.() ?? {}),
      ...(secondary.getStats?.() ?? {}),
      'Lookups that fell back': fallbacks,
    }),
  };
}

export type ResolveVia = 'auto' | 'file' | 'chaingraph' | 'fulcrum';

/**
 * Pick the resolution backend for a run.
 *
 * - `auto`: live Chaingraph when CHAINGRAPH_URL is set (with Fulcrum as fallback
 *   when FULCRUM_WS_URL is also set), else Fulcrum, else the embedded snapshot.
 * - `file`: embedded snapshot only (no network).
 * - `chaingraph` / `fulcrum`: force that live source.
 *
 * @returns The backend, or null for snapshot-only resolution
 * @throws When the requested source is not available
 */
export function chooseResolutionBackend(
  resolveVia: ResolveVia,
  hasSnapshot: boolean,
  env: { CHAINGRAPH_URL?: string; FULCRUM_WS_URL?: string } = { CHAINGRAPH_URL: process.env.CHAINGRAPH_URL, FULCRUM_WS_URL: process.env.FULCRUM_WS_URL }
): AuthchainBackend | null {
  const chaingraphUrl = env.CHAINGRAPH_URL;
  const fulcrumUrl = env.FULCRUM_WS_URL;

  switch (resolveVia) {
    case 'file':
      if (!hasSnapshot) {
        throw new Error(
          'The Chaingraph result file has no embedded resolution data; produce it with --query-chaingraph (embedding is on by default) or choose another --resolve-via source'
        );
      }
      return null;
    case 'chaingraph':
      if (!chaingraphUrl) throw new Error('--resolve-via chaingraph requires CHAINGRAPH_URL');
      return createChaingraphBackend({ url: chaingraphUrl });
    case 'fulcrum':
      if (!fulcrumUrl) throw new Error('--resolve-via fulcrum requires FULCRUM_WS_URL');
      return createFulcrumBackend();
    case 'auto':
    default:
      if (chaingraphUrl && fulcrumUrl) {
        return withFallback(createChaingraphBackend({ url: chaingraphUrl }), createFulcrumBackend());
      }
      if (chaingraphUrl) return createChaingraphBackend({ url: chaingraphUrl });
      if (fulcrumUrl) return createFulcrumBackend();
      if (hasSnapshot) return null;
      throw new Error(
        'No resolution source: set CHAINGRAPH_URL or FULCRUM_WS_URL, or use a Chaingraph result file with embedded resolution data'
      );
  }
}

/**
 * Embedded (snapshot) resolution data carried by a Chaingraph result row
 */
interface SnapshotData {
  entry: AuthchainCacheEntry | null; // null when the row carries no authchain
  parentTxId: string | null;         // null when unknown
}

function snapshotFromOutput(output: BCMROutput, txHash: string, timestamp: number): SnapshotData {
  const row = output.transaction?.authchains?.[0];
  const outpoint = output.transaction?.inputs?.[0]?.outpoint_transaction_hash;
  let entry: AuthchainCacheEntry | null = null;
  if (row) {
    const resolution = chainResolutionFromRow(row);
    entry = {
      authbase: txHash,
      authhead: resolution.authhead,
      chainLength: resolution.chainLength,
      isActive: resolution.isActive,
      lastCheckedTimestamp: timestamp,
    };
  }
  return { entry, parentTxId: outpoint ? fromBytea(outpoint) : null };
}

/**
 * Result from authchain resolution with cache statistics
 */
interface AuthchainResolutionResult {
  entry: AuthchainCacheEntry;
  /**
   * Number of output-0 spend lookups performed. Lookups are memoised per run,
   * so this can exceed the number of real backend queries.
   */
  lookups: number;
  cacheHitType: 'perfect' | 'good' | 'partial' | 'miss' | 'snapshot';
  /** True when the tail of the chain was resolved server-side in one call */
  escalated?: boolean;
  /**
   * Set when the walk was aborted by a backend error. `entry` then describes
   * the last position reached, with `isActive = false`, and must not be cached.
   */
  error?: string;
}

/**
 * Looks up the transaction spending output 0 of `txid` (null if unspent)
 */
type SpendLookup = (txid: string) => Promise<string | null>;

/** Hops walked in one run before a whole-chain resolver (if any) takes over */
const DEFAULT_ESCALATE_AFTER_HOPS = 25;

/**
 * Resolve authchain to find the current authhead
 * Follows the chain of transactions spending output 0 until an unspent output is found
 * Uses cache to avoid redundant queries when possible
 *
 * A backend error aborts the walk and is reported in the result instead of
 * being thrown, so one bad announcement never fails a whole batch. The result
 * then carries `error`, `isActive = false`, and must not be written to the cache.
 *
 * @param startTxid - Transaction hash to start walking from (a BCMR announcement)
 * @param lookupSpendingTx - Output-0 spend lookup (memoised by the caller)
 * @param cache - Optional cache to check for existing authchain data
 * @param resolveChain - Optional whole-chain resolver used once a walk gets long
 * @param escalateAfterHops - Hops walked before handing over to `resolveChain`
 * @returns Resolution result with cache entry, lookup count, and hit type
 */
async function resolveAuthchain(
  startTxid: string,
  lookupSpendingTx: SpendLookup,
  cache?: AuthchainCache,
  resolveChain?: (txid: string) => Promise<ChainResolution>,
  escalateAfterHops: number = DEFAULT_ESCALATE_AFTER_HOPS
): Promise<AuthchainResolutionResult> {
  const cachedEntry = cache?.entries[startTxid];
  // Cap on hops walked in one run. It bounds the work for an auth UTXO that
  // drifted into endless wallet traffic; it is not a cap on chain length, so
  // a seed (cache or snapshot) that is already thousands of hops along still
  // costs a single lookup.
  const maxHopsPerRun = 1000;

  // OPTIMIZATION 1: Inactive chains (exceeded max length) never become active again
  if (cachedEntry && !cachedEntry.isActive) {
    return {
      entry: cachedEntry,
      lookups: 0,
      cacheHitType: 'perfect',
    };
  }

  // OPTIMIZATION 2: For cached active chains, continue from the cached authhead.
  // If it is still unspent this costs a single lookup ('good'); if it was spent
  // the walk continues from there instead of from the start ('partial').
  let currentTxid = startTxid;
  let chainLength = 1;
  let cacheHitType: AuthchainResolutionResult['cacheHitType'] = 'miss';

  if (cachedEntry) {
    currentTxid = cachedEntry.authhead;
    chainLength = cachedEntry.chainLength;
    cacheHitType = 'good';
  }

  let lookups = 0;
  let hopsThisRun = 0;

  try {
    while (hopsThisRun < maxHopsPerRun) {
      // A long walk means the auth UTXO drifted into ordinary wallet traffic.
      // Hand the rest to the server-side resolver when one is available.
      if (resolveChain && hopsThisRun >= escalateAfterHops) {
        const rest = await resolveChain(currentTxid);
        lookups++;
        return {
          entry: {
            authbase: startTxid,
            authhead: rest.authhead,
            chainLength: chainLength + rest.chainLength - 1,
            isActive: rest.isActive,
            lastCheckedTimestamp: Date.now(),
          },
          lookups,
          cacheHitType,
          escalated: true,
        };
      }

      const spendingTxid = await lookupSpendingTx(currentTxid);
      lookups++;

      if (spendingTxid === null) {
        // Output 0 is unspent - this is the authhead
        return {
          entry: {
            authbase: startTxid,
            authhead: currentTxid,
            chainLength,
            isActive: true,
            lastCheckedTimestamp: Date.now(),
          },
          lookups,
          cacheHitType,
        };
      }

      // Output 0 is spent, follow the chain
      currentTxid = spendingTxid;
      chainLength++;
      hopsThisRun++;
      if (cachedEntry) {
        cacheHitType = 'partial';
      }
    }

    // Hit the per-run hop cap
    console.warn(
      `Warning: Authchain walk exceeded ${maxHopsPerRun} hops in one run for ${startTxid} (chain length so far ${chainLength})`
    );
    return {
      entry: {
        authbase: startTxid,
        authhead: currentTxid,
        chainLength,
        isActive: false,
        lastCheckedTimestamp: Date.now(),
      },
      lookups,
      cacheHitType,
    };
  } catch (error) {
    // The authhead is unknown: report the failure, never cache it
    return {
      entry: {
        authbase: startTxid,
        authhead: currentTxid,
        chainLength,
        isActive: false,
        lastCheckedTimestamp: Date.now(),
      },
      lookups,
      cacheHitType,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Shape of a Chaingraph result file (raw GraphQL response plus optional metadata)
 */
export interface ChaingraphResultData {
  meta?: { generatedAt?: string; embeddedResolution?: boolean };
  data?: { search_output_prefix?: BCMROutput[] };
  errors?: Array<{ message: string }>;
}

/**
 * True when at least one row of the Chaingraph data carries embedded resolution
 */
export function hasEmbeddedResolution(data: ChaingraphResultData | undefined): boolean {
  return Boolean(data?.data?.search_output_prefix?.some((o) => o.transaction?.authchains?.length));
}

/**
 * A single BCMR announcement (one OP_RETURN output) after authchain resolution
 */
interface ResolvedAnnouncement {
  txHash: string;
  output: BCMROutput;
  parsed: ParsedBCMR;
  resolution: AuthchainResolutionResult;
}

/**
 * Block height of the announcement transaction (0 if unconfirmed)
 */
function announcementHeight(output: BCMROutput): number {
  const height = output.transaction.block_inclusions[0]?.block.height;
  return height ? parseInt(String(height)) : 0;
}

/**
 * Fetch all BCMR registries from Chaingraph
 *
 * Every BCMR OP_RETURN output returned by Chaingraph is an *announcement*. An
 * identity that has been updated N times has N announcements, all of which walk
 * forward (via output 0) to the same unspent authhead. Announcements are therefore
 * grouped by authhead: the member closest to the head (smallest chain length)
 * is the identity's current registry and the rest are reported with
 * `isSuperseded = true`. The token category (tokenId) is derived once per
 * identity from the earliest announcement, whose input 0 spends the genesis
 * output in the common case.
 *
 * Uses authchain caching and per-run memoisation to avoid redundant Fulcrum queries.
 *
 * @param options - Optional configuration
 * @param options.useCache - Whether to use cache (default: true)
 * @param options.cachePath - Path to cache file (default: ./bcmr-registries/.authchain-cache.json)
 * @param options.verbose - Enable verbose logging for detailed diagnostics (default: false)
 * @param options.concurrency - Number of parallel authchain resolutions (default: 50)
 * @param options.chaingraphData - Pre-loaded Chaingraph data (if provided, skips Chaingraph query)
 * @param options.backend - Resolution backend (default: Fulcrum). `null` resolves from the
 *   snapshot embedded in the Chaingraph data only, without any network access.
 * @param options.useSnapshot - Seed resolution from embedded snapshot data when present (default: true)
 * @param options.escalateAfterHops - Hops walked before a whole-chain resolver takes over (default: 25)
 */
export async function getBCMRRegistries(options?: {
  useCache?: boolean;
  cachePath?: string;
  verbose?: boolean;
  concurrency?: number;
  chaingraphData?: ChaingraphResultData;
  backend?: AuthchainBackend | null;
  useSnapshot?: boolean;
  escalateAfterHops?: number;
}): Promise<BCMRRegistry[]> {
  const useCache = options?.useCache !== false;
  const cachePath = options?.cachePath || './bcmr-registries/.authchain-cache.json';
  const verbose = options?.verbose || false;
  const concurrency = options?.concurrency || 50;
  const chaingraphData = options?.chaingraphData;
  const backend: AuthchainBackend | null = options?.backend === undefined ? createFulcrumBackend() : options.backend;
  const useSnapshot = options?.useSnapshot !== false;
  const escalateAfterHops = options?.escalateAfterHops ?? DEFAULT_ESCALATE_AFTER_HOPS;

  try {
    // Load cache if enabled
    let oldCache: AuthchainCache | undefined;
    if (useCache) {
      oldCache = loadAuthchainCache(cachePath);
      const stats = getCacheStats(oldCache);

      if (stats.totalEntries > 0) {
        // Calculate cache age
        const timestamps = Object.values(oldCache.entries).map(e => e.lastCheckedTimestamp);
        const oldestTimestamp = Math.min(...timestamps);
        const newestTimestamp = Math.max(...timestamps);
        const ageHours = ((Date.now() - oldestTimestamp) / (1000 * 60 * 60)).toFixed(1);
        const newestAgeHours = ((Date.now() - newestTimestamp) / (1000 * 60 * 60)).toFixed(1);

        console.log(
          `Loaded authchain cache from ${cachePath}`
        );
        console.log(
          `  ${stats.totalEntries} entries (${stats.activeEntries} active, ${stats.inactiveEntries} inactive)`
        );
        console.log(
          `  Cache age: oldest ${ageHours}h, newest ${newestAgeHours}h`
        );
      } else {
        console.log(`Authchain cache enabled (building new cache at ${cachePath})`);
      }
    } else {
      console.log('Authchain cache disabled (--no-cache)');
    }

    // Use pre-loaded data or fetch from Chaingraph
    let data: ChaingraphResultData;

    if (chaingraphData) {
      // Use pre-loaded data
      console.log('Using pre-loaded Chaingraph data...');
      data = chaingraphData;
    } else {
      // Fetch from Chaingraph (paged; a single request is capped at 5000 rows)
      const outputsFromChaingraph = await fetchBCMROutputs<BCMROutput>();
      data = { data: { search_output_prefix: outputsFromChaingraph } };
    }

    const outputs: BCMROutput[] = data.data?.search_output_prefix || [];

    // Filter to keep only first BCMR output per transaction
    const validOutputs = filterFirstOutputOnly(outputs);

    // Embedded snapshot: resolution data the producer of the result file
    // fetched from Chaingraph. Without a live backend it is the answer; with
    // one it seeds the cache so each identity costs a single "still unspent?"
    // lookup instead of a walk.
    const snapshotTime = Date.parse(data.meta?.generatedAt ?? '') || Date.now();
    const snapshots = new Map<string, SnapshotData>();
    if (useSnapshot) {
      for (const output of validOutputs) {
        const txHash = stripHexPrefix(output.transaction_hash);
        const snapshot = snapshotFromOutput(output, txHash, snapshotTime);
        if (snapshot.entry || snapshot.parentTxId) {
          snapshots.set(txHash, snapshot);
        }
      }
    }
    const snapshotCount = Array.from(snapshots.values()).filter((s) => s.entry).length;

    if (backend === null) {
      console.log(
        `Resolving from the embedded snapshot only (${snapshotCount}/${validOutputs.length} announcements carry resolution data` +
          (data.meta?.generatedAt ? `, generated ${data.meta.generatedAt}` : '') +
          '); no live verification'
      );
    } else {
      console.log(`Resolution backend: ${backend.name}`);
      if (snapshotCount > 0) {
        console.log(`  Seeding from embedded snapshot: ${snapshotCount} announcements`);
        let seeded = 0;
        const seedCache = oldCache ?? createEmptyCache();
        for (const [txHash, snapshot] of snapshots) {
          if (!snapshot.entry || !snapshot.entry.isActive) continue;
          const existing = seedCache.entries[txHash];
          // The seed that is furthest along the chain saves the most hops
          if (!existing || (existing.isActive && snapshot.entry.chainLength > existing.chainLength)) {
            seedCache.entries[txHash] = { ...snapshot.entry, parentTxId: existing?.parentTxId };
            seeded++;
          }
        }
        oldCache = seedCache;
        if (verbose) console.log(`  ${seeded} cache entries seeded or advanced by the snapshot`);
      }
    }

    // Memoise output-0 spend lookups for this run. Every announcement of an
    // identity walks the same tail of the chain to the shared authhead, so
    // without memoisation that tail is queried once per announcement.
    const spendMemo = new Map<string, Promise<string | null>>();
    let spendQueries = 0;
    const lookupSpendingTx: SpendLookup = (txid) => {
      let pending = spendMemo.get(txid);
      if (!pending) {
        if (backend === null) {
          return Promise.reject(new Error('No embedded resolution data for this announcement and no live backend'));
        }
        spendQueries++;
        pending = backend.getSpendingTx(txid).catch((error) => {
          spendMemo.delete(txid); // Don't memoise failures
          throw error;
        });
        spendMemo.set(txid, pending);
      }
      return pending;
    };
    const resolveChain = backend?.resolveChain ? (txid: string) => backend.resolveChain!(txid) : undefined;

    // Build new cache as we process announcements
    const newCache = createEmptyCache();
    const announcements: ResolvedAnnouncement[] = [];

    // Track detailed cache performance
    let perfectCacheHits = 0;   // Inactive chains (0 lookups)
    let goodCacheHits = 0;      // Active chains still unspent (1 lookup)
    let partialCacheHits = 0;   // Active chains continued from cache (N lookups)
    let cacheMisses = 0;        // No cache entry (full walk)
    let snapshotHits = 0;       // Answered by the embedded snapshot (no backend)
    let escalations = 0;        // Long walks finished by the server-side resolver
    let totalLookups = 0;
    let processedCount = 0;
    let resolutionErrors = 0;   // Walks aborted by a backend error (not cached)
    let tokenIdErrors = 0;      // Identities skipped because the tokenId lookup failed
    let parentLookups = 0;      // tokenId lookups that needed the backend

    console.log(`Resolving authchains for ${validOutputs.length} announcements (concurrency: ${concurrency})...`);
    const startTime = Date.now();

    /**
     * Phase 1: resolve the authchain of a single announcement
     */
    const resolveOutput = async (output: BCMROutput): Promise<ResolvedAnnouncement | null> => {
      const parsed = parseBCMRBytecode(output.locking_bytecode);

      if (!parsed) {
        return null;
      }

      // Strip hex prefix from transaction hash
      const txHash = stripHexPrefix(output.transaction_hash);

      if (backend === null) {
        // Snapshot-only: the embedded answer is final
        const entry = snapshots.get(txHash)?.entry;
        const resolution: AuthchainResolutionResult = entry
          ? { entry, lookups: 0, cacheHitType: 'snapshot' }
          : {
              entry: { authbase: txHash, authhead: txHash, chainLength: 1, isActive: false, lastCheckedTimestamp: Date.now() },
              lookups: 0,
              cacheHitType: 'snapshot',
              error: 'No embedded resolution data for this announcement (re-run --query-chaingraph or use a live source)',
            };
        return { txHash, output, parsed, resolution };
      }

      const resolution = await resolveAuthchain(txHash, lookupSpendingTx, oldCache, resolveChain, escalateAfterHops);

      return { txHash, output, parsed, resolution };
    };

    /**
     * Process announcements in parallel with concurrency control
     */
    const resolveBatch = async (batch: BCMROutput[]): Promise<void> => {
      const results = await Promise.all(batch.map(resolveOutput));

      // Update statistics and cache
      for (const result of results) {
        if (result) {
          const { resolution } = result;

          // Update cache statistics
          totalLookups += resolution.lookups;

          switch (resolution.cacheHitType) {
            case 'perfect':
              perfectCacheHits++;
              break;
            case 'good':
              goodCacheHits++;
              break;
            case 'partial':
              partialCacheHits++;
              break;
            case 'miss':
              cacheMisses++;
              break;
            case 'snapshot':
              snapshotHits++;
              break;
          }
          if (resolution.escalated) {
            escalations++;
          }

          if (resolution.error) {
            // An aborted walk has no trustworthy authhead: never cache it
            resolutionErrors++;
            if (verbose) {
              console.warn(`  Warning: authchain walk failed for ${result.txHash}: ${resolution.error}`);
            }
          } else {
            // Store in new cache (keyed by announcement tx)
            newCache.entries[result.txHash] = resolution.entry;
          }

          announcements.push(result);

          // Verbose logging
          if (verbose) {
            const hitTypeDesc: Record<string, string> = {
              perfect: 'perfect hit (0 lookups)',
              good: `good hit (1 lookup)`,
              partial: `partial hit (${resolution.lookups} lookups)`,
              miss: `miss (${resolution.lookups} lookups)`,
              snapshot: 'embedded snapshot (0 lookups)',
            };

            console.log(
              `  [${processedCount + 1}/${validOutputs.length}] ${result.txHash.substring(0, 8)}... -> authhead ${resolution.entry.authhead.substring(0, 8)}... (length ${resolution.entry.chainLength}) ${hitTypeDesc[resolution.cacheHitType]}`
            );
          }
        }

        processedCount++;
      }

      // Progress reporting
      if (processedCount % 100 === 0 || processedCount === validOutputs.length) {
        const elapsedMs = Math.max(Date.now() - startTime, 1);
        const elapsed = (elapsedMs / 1000).toFixed(1);
        const rate = ((processedCount / elapsedMs) * 1000).toFixed(1);
        console.log(`  Resolving authchains... ${processedCount}/${validOutputs.length} (${elapsed}s, ${rate} tx/s)`);
      }
    };

    // Process in batches with concurrency control
    for (let i = 0; i < validOutputs.length; i += concurrency) {
      await resolveBatch(validOutputs.slice(i, i + concurrency));
    }

    // Phase 2: group announcements by authhead (one group per identity).
    // An announcement whose walk failed has no known authhead; keep it on its
    // own so it can neither join nor supersede a properly resolved identity.
    const groups = new Map<string, ResolvedAnnouncement[]>();
    for (const announcement of announcements) {
      const authhead = announcement.resolution.error
        ? `error:${announcement.txHash}`
        : announcement.resolution.entry.authhead;
      const group = groups.get(authhead);
      if (group) {
        group.push(announcement);
      } else {
        groups.set(authhead, [announcement]);
      }
    }

    console.log(`Grouped ${announcements.length} announcements into ${groups.size} identities`);

    /**
     * Phase 3: build registry entries for one identity
     *
     * Members are ordered by distance to the authhead. The closest member
     * (smallest chain length) carries the current registry; all others are
     * superseded. The token category is derived from the farthest member
     * (the earliest announcement), whose input 0 spends the genesis output
     * when the first announcement is the genesis transaction.
     */
    const buildGroup = async (group: ResolvedAnnouncement[]): Promise<BCMRRegistry[]> => {
      group.sort(
        (a, b) =>
          a.resolution.entry.chainLength - b.resolution.entry.chainLength ||
          announcementHeight(b.output) - announcementHeight(a.output)
      );

      const current = group[0];
      const earliest = group[group.length - 1];

      let tokenId: string | null = '';
      if (current.resolution.error) {
        // The authhead is unknown, so the announcement is excluded anyway;
        // report it as unresolved without spending a lookup on its tokenId.
        return [
          {
            authbase: earliest.txHash,
            authhead: current.resolution.entry.authhead,
            tokenId,
            blockHeight: announcementHeight(current.output),
            hash: current.parsed.hash,
            uris: current.parsed.uris,
            isBurned: isOutputBurned(current.output),
            isValid: current.parsed.uris.length > 0,
            authchainLength: earliest.resolution.entry.chainLength,
            isAuthheadUnspent: false,
            isSuperseded: false,
            resolutionError: current.resolution.error,
          },
        ];
      }

      // The parent of a transaction never changes: prefer the snapshot, then the
      // cache, and only then ask the backend.
      const known = snapshots.get(earliest.txHash)?.parentTxId ?? oldCache?.entries[earliest.txHash]?.parentTxId ?? null;
      try {
        if (known) {
          tokenId = known;
        } else if (backend === null) {
          throw new Error('no embedded parent transaction');
        } else {
          parentLookups++;
          tokenId = await backend.getParentTxId(earliest.txHash);
        }
      } catch (error) {
        tokenIdErrors++;
        console.warn(
          `Warning: tokenId lookup failed for authbase ${earliest.txHash}, skipping identity: ${error instanceof Error ? error.message : error}`
        );
        return [];
      }
      if (!tokenId) {
        tokenIdErrors++;
        console.warn(`Warning: authbase ${earliest.txHash} has no parent transaction, skipping identity`);
        return [];
      }

      // Remember the parent so later runs skip this lookup
      const cachedAuthbase = newCache.entries[earliest.txHash];
      if (cachedAuthbase) {
        cachedAuthbase.parentTxId = tokenId;
      }

      return group.map((member, index) => ({
        authbase: earliest.txHash,
        authhead: current.resolution.entry.authhead,
        tokenId,
        blockHeight: announcementHeight(member.output),
        hash: member.parsed.hash,
        uris: member.parsed.uris,
        isBurned: isOutputBurned(member.output),
        isValid: member.parsed.uris.length > 0,
        authchainLength: earliest.resolution.entry.chainLength,
        isAuthheadUnspent: current.resolution.entry.isActive,
        isSuperseded: index > 0,
        resolutionError: current.resolution.error ?? null,
      }));
    };

    const registries: BCMRRegistry[] = [];
    const groupList = Array.from(groups.values());
    for (let i = 0; i < groupList.length; i += concurrency) {
      const built = await Promise.all(groupList.slice(i, i + concurrency).map(buildGroup));
      for (const entries of built) {
        registries.push(...entries);
      }
    }

    const endTime = Date.now();
    const durationSeconds = ((endTime - startTime) / 1000).toFixed(2);
    const avgTimePerAnnouncement = validOutputs.length > 0
      ? ((endTime - startTime) / validOutputs.length).toFixed(0)
      : '0';
    const supersededCount = registries.filter((r) => r.isSuperseded).length;

    console.log(`Authchain resolution complete in ${durationSeconds}s (avg ${avgTimePerAnnouncement}ms per announcement)`);
    console.log(`  ${registries.length - supersededCount} current registries, ${supersededCount} superseded announcements`);
    if (resolutionErrors > 0) {
      console.warn(`  ${resolutionErrors} authchain walks failed (authhead unknown, not cached; re-run to retry)`);
    }
    if (tokenIdErrors > 0) {
      console.warn(`  ${tokenIdErrors} identities skipped because the tokenId lookup failed`);
    }

    // Display detailed cache statistics
    if (useCache && backend !== null) {
      const totalHits = perfectCacheHits + goodCacheHits + partialCacheHits;
      const totalResolved = totalHits + cacheMisses;
      const hitPercent = totalResolved > 0 ? ((totalHits / totalResolved) * 100).toFixed(1) : '0.0';

      console.log('\nCache Performance:');
      console.log(`  Perfect hits: ${perfectCacheHits} (0 lookups each)`);
      console.log(`  Good hits: ${goodCacheHits} (1 lookup each)`);
      console.log(`  Partial hits: ${partialCacheHits} (continued from cache)`);
      console.log(`  Misses: ${cacheMisses} (full authchain walk)`);
      console.log(`  Total: ${totalHits}/${totalResolved} cached (${hitPercent}%)`);
    }

    if (backend === null) {
      console.log(`\nSnapshot Statistics:`);
      console.log(`  Announcements answered by the embedded snapshot: ${snapshotHits}`);
      console.log(`  Announcements without snapshot data: ${resolutionErrors}`);
      console.log('  No blockchain queries were made; results are as fresh as the result file');
    } else {
      const totalQueries = spendQueries + parentLookups;
      console.log('\nBackend Query Statistics:');
      console.log(`  Spend lookups: ${totalLookups} (${spendQueries} queries after memoisation)`);
      console.log(`  Token ID lookups: ${parentLookups} (identities not covered by snapshot or cache)`);
      if (escalations > 0) {
        console.log(`  Long walks finished server-side: ${escalations}`);
      }
      console.log(`  Total queries: ${totalQueries}`);
      console.log(`  Average per announcement: ${validOutputs.length > 0 ? (totalQueries / validOutputs.length).toFixed(2) : '0.00'}`);
      for (const [label, value] of Object.entries(backend.getStats?.() ?? {})) {
        console.log(`  ${label}: ${value}`);
      }
    }

    if (useCache) {
      // Save cache (atomic - only if we got here successfully)
      saveAuthchainCache(newCache, cachePath);
      console.log(`\nCache saved to ${cachePath}`);
    }

    // Sort by block height (newest first)
    registries.sort((a, b) => b.blockHeight - a.blockHeight);

    return registries;
  } catch (error) {
    console.error('Error fetching BCMR registries:', error);
    throw error;
  }
}

/**
 * Result of IPFS gateway detection
 */
interface IPFSGatewayDetection {
  isGateway: boolean;
  gateway: string | null;    // Normalized gateway domain (e.g., "ipfs.io" or "192.168.1.100:8080")
  cid: string | null;        // Extracted CID
  pathAfterCid: string;      // Path after CID (including leading /)
}

/**
 * Detect if URL uses IPFS gateway and extract gateway domain + CID
 *
 * Detects both formats:
 * - Path style: https://ipfs.io/ipfs/QmHash/path → gateway="ipfs.io"
 * - Subdomain style: https://QmHash.ipfs.dweb.link/path → gateway="dweb.link"
 *
 * @param url - URL string to check
 * @returns Detection result with gateway domain, CID, and path
 */
function detectIPFSGateway(url: string): IPFSGatewayDetection {
  const notGateway: IPFSGatewayDetection = {
    isGateway: false,
    gateway: null,
    cid: null,
    pathAfterCid: '',
  };

  try {
    const urlObj = new URL(url);

    // Only support http/https protocols
    if (urlObj.protocol !== 'https:' && urlObj.protocol !== 'http:') {
      return notGateway;
    }

    // Check for path-style gateway: /ipfs/{CID}/...
    const pathMatch = urlObj.pathname.match(/^\/ipfs\/([^\/]+)(\/.*)?$/);
    if (pathMatch) {
      const cid = pathMatch[1];
      const pathAfterCid = pathMatch[2] || '';

      // Validate CID format (basic check - just verify it looks like a CID)
      if (cid.length < 10 || !/^[a-zA-Z0-9]+$/.test(cid)) {
        return notGateway;
      }

      // Extract gateway (hostname with port if present)
      const gateway = urlObj.port
        ? `${urlObj.hostname}:${urlObj.port}`.toLowerCase()
        : urlObj.hostname.toLowerCase();

      return {
        isGateway: true,
        gateway,
        cid,
        pathAfterCid,
      };
    }

    // Check for subdomain-style gateway: {CID}.ipfs.{domain}
    const subdomainMatch = urlObj.hostname.match(/^([^.]+)\.ipfs\.(.+)$/i);
    if (subdomainMatch) {
      const cid = subdomainMatch[1];
      const baseDomain = subdomainMatch[2];

      // Validate CID format (basic check)
      if (cid.length < 10 || !/^[a-zA-Z0-9]+$/.test(cid)) {
        return notGateway;
      }

      // Extract gateway domain (base domain after .ipfs., with port if present)
      const gateway = urlObj.port
        ? `${baseDomain}:${urlObj.port}`.toLowerCase()
        : baseDomain.toLowerCase();

      // Path after CID is the full pathname
      const pathAfterCid = urlObj.pathname;

      return {
        isGateway: true,
        gateway,
        cid,
        pathAfterCid,
      };
    }

    // No IPFS gateway pattern detected
    return notGateway;
  } catch (e) {
    // Invalid URL
    return notGateway;
  }
}

/**
 * Result of resolving a blockchain URI to a fetchable URL
 */
export interface ResolvedUrl {
  url: string;
  /** True when the URL's host is a gateway the user configured (trusted) */
  userGateway: boolean;
}

/**
 * Rewrite IPFS gateway URL based on configuration
 * Priority: gatewayMapping > global rewrite > no change
 *
 * @param url - Original URL
 * @param config - Gateway configuration
 * @returns Rewritten URL (flagged as user gateway) or original if no rewriting applies
 */
function rewriteGatewayUrl(url: string, config: GatewayConfig): ResolvedUrl {
  // Detect if this is an IPFS gateway URL
  const detection = detectIPFSGateway(url);

  if (!detection.isGateway || !detection.gateway || !detection.cid) {
    // Not a gateway URL, return unchanged
    return { url, userGateway: false };
  }

  let targetGateway: string | null = null;

  // Priority 1: Check gateway mapping (highest priority)
  if (config.gatewayMapping) {
    const mapped = config.gatewayMapping.get(detection.gateway);
    if (mapped) {
      targetGateway = mapped;
    }
  }

  // Priority 2: Check global rewrite
  if (!targetGateway && config.rewriteAllGateways && config.targetGateway) {
    targetGateway = config.targetGateway;
  }

  // If no rewriting applies, return original URL
  if (!targetGateway) {
    return { url, userGateway: false };
  }

  // Reconstruct URL in path-style format (more compatible)
  return {
    url: `${gatewayBaseUrl(targetGateway)}/ipfs/${detection.cid}${detection.pathAfterCid}`,
    userGateway: true,
  };
}

/**
 * Validate a blockchain-sourced http(s) URL and apply gateway rewriting
 * SECURITY: internal/private hosts and non-standard ports are rejected
 * BEFORE rewriting; the rewrite target is user-configured and therefore trusted
 */
function validateAndRewrite(httpUrl: string, config: GatewayConfig): ResolvedUrl {
  const url = new URL(httpUrl);

  if (isInternalHostname(url.hostname)) {
    throw new Error(`Internal/private hostnames not allowed: ${url.hostname}`);
  }

  if (url.port && !['', '80', '443'].includes(url.port)) {
    throw new Error(`Non-standard ports not allowed: ${url.port}`);
  }

  return rewriteGatewayUrl(httpUrl, config);
}

/**
 * Resolve a blockchain URI to a fetchable HTTP(S) URL
 * - ipfs:// URIs are converted to IPFS gateway URLs (configurable gateway)
 * - URIs without protocol are assumed to be HTTPS per BCMR spec
 * - http:// and https:// URIs are validated for security and optionally rewritten
 *
 * SECURITY - Trust Model:
 * - Blockchain input (URIs): UNTRUSTED - validated for SSRF protection
 *   - Internal/private hosts blocked (see ssrf.ts for the full list)
 *   - Non-standard ports blocked (only 80/443 allowed)
 *   - Redirects and DNS answers are re-checked at fetch time (safeFetch)
 * - User input (gateway config): TRUSTED - can specify private IPs
 *   - Gateway rewriting happens AFTER blockchain validation
 *   - Users explicitly choose to redirect to private gateways
 *
 * @param uri - URI to resolve (from blockchain, untrusted)
 * @param config - Optional gateway configuration for rewriting (user-configured, trusted)
 * @returns Resolved URL and whether it targets a user-configured gateway
 */
export function resolveUri(uri: string, config?: GatewayConfig): ResolvedUrl {
  // Default configuration
  const gatewayConfig: GatewayConfig = config || {
    defaultGateway: 'ipfs.io',
    rewriteAllGateways: false,
    targetGateway: null,
    gatewayMapping: null,
  };

  if (uri.startsWith('ipfs://')) {
    const hash = uri.replace('ipfs://', '');
    // Use configurable gateway (may be a private IP or plain http if user configured it)
    return { url: `${gatewayBaseUrl(gatewayConfig.defaultGateway)}/ipfs/${hash}`, userGateway: true };
  }

  // If URI already has a protocol
  if (uri.startsWith('https://') || uri.startsWith('http://')) {
    try {
      return validateAndRewrite(uri, gatewayConfig);
    } catch (error) {
      throw new Error(`Invalid or unsafe URI: ${error instanceof Error ? error.message : error}`);
    }
  }

  // Per BCMR spec: URIs without protocol prefix assume HTTPS
  try {
    return validateAndRewrite(`https://${uri}`, gatewayConfig);
  } catch (error) {
    throw new Error(`Invalid URI format: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Normalize URI to a clickable HTTP(S) URL (see resolveUri for the rules)
 */
export function normalizeUri(uri: string, config?: GatewayConfig): string {
  return resolveUri(uri, config).url;
}

/**
 * Legacy alias for backward compatibility
 */
export function ipfsToGateway(uri: string): string {
  return normalizeUri(uri);
}

/**
 * Result types for fetchAndValidateRegistry
 */
export type FetchValidateResult =
  | { success: true; json: any; rawContent: string; rawBytes: Buffer; computedHash: string; hashVerified: boolean }
  | { success: false; schemaInvalid: true; computedHash: string; validationErrors: string[] }
  | { success: false; schemaInvalid: false };

/**
 * Fetch and validate a BCMR registry JSON from URIs
 * Tries each URI in order until one succeeds
 *
 * @param uris - Array of URIs to try (IPFS and HTTPS)
 * @param expectedHash - Expected SHA-256 hash of the JSON content
 * @param maxRetries - Maximum number of retries per URI (default: 2)
 * @param timeoutMs - Timeout in milliseconds (default: 2000)
 * @param validateSchema - Enable JSON schema validation (default: false)
 * @param validationCacheEntry - Optional validation cache entry for this hash
 * @param ignoreJsonHash - Store files regardless of hash verification (default: false)
 * @param config - Gateway configuration (user-configured, trusted)
 * @param maxBytes - Maximum response body size in bytes (default: 50MB)
 * @returns Result object with success status, content, and validation details
 */
export async function fetchAndValidateRegistry(
  uris: string[],
  expectedHash: string,
  maxRetries: number = 2,
  timeoutMs: number = 2000,
  validateSchema: boolean = false,
  validationCacheEntry?: { hash: string; url: string; isValid: boolean } | null,
  ignoreJsonHash: boolean = false,
  config?: GatewayConfig,
  maxBytes: number = 50 * 1024 * 1024
): Promise<FetchValidateResult> {
  // Check validation cache before attempting download
  if (validateSchema && validationCacheEntry && !validationCacheEntry.isValid) {
    console.warn(
      `Skipping known-invalid JSON from cache: ${validationCacheEntry.hash.substring(0, 12)}... (${validationCacheEntry.url})`
    );
    return { success: false, schemaInvalid: false };
  }

  for (const uri of uris) {
    // Convert IPFS URIs to gateway URLs (with optional gateway rewriting)
    // An unsafe URI only disqualifies itself, not the registry's other URIs
    let resolved: ResolvedUrl;
    try {
      resolved = resolveUri(uri, config);
    } catch (error) {
      console.warn(`Skipping ${uri}: ${error instanceof Error ? error.message : error}`);
      continue;
    }
    const fetchUrl = resolved.url;
    const urlDisplay = uri !== fetchUrl ? `${uri} → ${fetchUrl}` : uri;
    // Only the user's own gateway host is exempt from SSRF checks at fetch time
    const trustedHost = resolved.userGateway ? new URL(fetchUrl).host : null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      // The timeout covers the whole transfer (redirects + body), not just the headers
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await safeFetch(fetchUrl, {
          signal: controller.signal,
          maxBytes,
          trustedHost,
        });

        if (!response.ok) {
          console.warn(
            `Failed to fetch ${urlDisplay} (attempt ${attempt}/${maxRetries}): HTTP ${response.status}`
          );
          continue;
        }

        // Hash the exact bytes served; decode separately (TextDecoder strips a BOM for JSON.parse)
        const rawBytes = response.body;
        const rawContent = new TextDecoder('utf-8').decode(rawBytes);
        const computedHash = createHash('sha256').update(rawBytes).digest('hex');

        // Verify hash matches
        const hashVerified = computedHash === expectedHash;
        if (!hashVerified) {
          if (ignoreJsonHash) {
            // Hash mismatch but ignoreJsonHash is enabled - continue processing
            console.warn(
              `⚠️  Hash mismatch for ${urlDisplay}: expected ${expectedHash}, got ${computedHash} (continuing due to --ignore-json-hash)`
            );
          } else {
            // Hash mismatch and ignoreJsonHash is disabled - fail
            console.warn(
              `Hash mismatch for ${urlDisplay}: expected ${expectedHash}, got ${computedHash}`
            );
            return { success: false, schemaInvalid: false }; // Hash mismatch - don't retry
          }
        }

        // Parse JSON
        try {
          const json = JSON.parse(rawContent);

          // Basic structure validation - must have identities object
          if (!json || typeof json !== 'object' || !json.identities) {
            console.warn(`Invalid BCMR structure from ${urlDisplay}: missing identities object`);
            return { success: false, schemaInvalid: false };
          }

          // Schema validation (if enabled)
          if (validateSchema) {
            const validation = await validateBCMRSchema(json);

            if (!validation.isValid) {
              console.warn(`Schema validation failed for ${urlDisplay}:`);
              // Show first 5 errors for readability
              validation.errors.slice(0, 5).forEach(err => console.warn(`  - ${err}`));
              if (validation.errors.length > 5) {
                console.warn(`  ... and ${validation.errors.length - 5} more errors`);
              }
              // Return schema validation failure with actual hash and errors
              return {
                success: false,
                schemaInvalid: true,
                computedHash,
                validationErrors: validation.errors
              };
            }
          }

          // Success! Return parsed JSON, raw content, computed hash, and hash verification status
          return { success: true, json, rawContent, rawBytes, computedHash, hashVerified };
        } catch (parseError) {
          console.warn(`JSON parse error from ${urlDisplay}:`, parseError);
          return { success: false, schemaInvalid: false };
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          console.warn(
            `Timeout fetching ${urlDisplay} (attempt ${attempt}/${maxRetries})`
          );
        } else {
          console.warn(
            `Error fetching ${urlDisplay} (attempt ${attempt}/${maxRetries}):`,
            error instanceof Error ? error.message : error
          );
        }

        // Wait before retry with exponential backoff
        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, attempt - 1)));
        }
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  // All URIs and retries failed (network errors, timeouts, etc.)
  return { success: false, schemaInvalid: false };
}
