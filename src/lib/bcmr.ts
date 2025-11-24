/**
 * BCMR (Bitcoin Cash Metadata Registries) Library
 * Fetches and parses BCMR registry announcements from the BCH blockchain
 */

import { getOutputSpendingTx, getTransaction } from './fulcrum-client.js';
import { createHash } from 'crypto';
import type { AuthchainCache, AuthchainCacheEntry } from './authchain-cache.js';
import {
  loadAuthchainCache,
  saveAuthchainCache,
  createEmptyCache,
  getCacheStats,
} from './authchain-cache.js';

// GraphQL query to fetch all BCMR outputs using prefix search
const BCMR_QUERY = `
  query SearchOutputsByLockingBytecodePrefix {
    search_output_prefix(
      args: { locking_bytecode_prefix_hex: "6a0442434d5220" }
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
  }
`;

interface BCMROutput {
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

interface BCMRRegistry {
  authbase: string; // Transaction hash where authchain starts
  authhead: string; // Latest transaction in authchain
  tokenId: string;  // Parent transaction ID of authbase (CashToken category ID)
  blockHeight: number;
  hash: string;
  uris: string[];
  isBurned: boolean;
  isValid: boolean;
  authchainLength: number; // Number of transactions in the authchain
  isAuthheadUnspent: boolean; // True if authhead output 0 is unspent (active registry)
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
        // Per BCMR spec: accept all non-empty URIs (protocol-less URIs assume HTTPS)
        if (uri.length > 0) {
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
 * Get the parent transaction ID of a given transaction
 * Returns the txid of the first input (vin[0].txid)
 * This is the CashToken category ID for genesis transactions
 * @param txid - Transaction hash to get parent of
 * @returns Parent transaction ID, or null if cannot be determined
 */
async function getParentTxId(txid: string): Promise<string | null> {
  try {
    const tx = await getTransaction(txid);

    // Return first input's txid (parent transaction)
    if (tx.vin && tx.vin.length > 0 && tx.vin[0].txid) {
      return tx.vin[0].txid;
    }

    return null;
  } catch (error) {
    console.error(`Failed to get parent txid for ${txid}:`, error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Result from authchain resolution with cache statistics
 */
interface AuthchainResolutionResult {
  entry: AuthchainCacheEntry;
  queriesUsed: number;
  cacheHitType: 'perfect' | 'good' | 'partial' | 'miss';
}

/**
 * Resolve authchain to find the current authhead
 * Follows the chain of transactions spending output 0 until an unspent output is found
 * Uses cache to avoid redundant queries when possible
 *
 * @param authbaseTxid - Starting transaction hash (authbase)
 * @param cache - Optional cache to check for existing authchain data
 * @returns Resolution result with cache entry, query count, and hit type
 */
async function resolveAuthchain(
  authbaseTxid: string,
  cache?: AuthchainCache
): Promise<AuthchainResolutionResult> {
  const cachedEntry = cache?.entries[authbaseTxid];

  // OPTIMIZATION 1: Inactive chains never become active again - perfect cache!
  if (cachedEntry && !cachedEntry.isActive) {
    return {
      entry: cachedEntry,
      queriesUsed: 0,
      cacheHitType: 'perfect',
    };
  }

  // OPTIMIZATION 2: For active chains, check if cached authhead is still unspent
  if (cachedEntry && cachedEntry.isActive) {
    const spendingTx = await getOutputSpendingTx(cachedEntry.authhead, 0);

    if (spendingTx === null) {
      // Still unspent - just update timestamp
      return {
        entry: {
          ...cachedEntry,
          lastCheckedTimestamp: Date.now(),
        },
        queriesUsed: 1,
        cacheHitType: 'good',
      };
    }

    // Authhead was spent! Continue from here instead of from authbase
    let currentTxid = spendingTx;
    let chainLength = cachedEntry.chainLength + 1;
    const maxChainLength = 1000;
    let queriesUsed = 1; // Initial check query

    try {
      while (chainLength < maxChainLength) {
        const nextSpendingTx = await getOutputSpendingTx(currentTxid, 0);
        queriesUsed++;

        if (nextSpendingTx === null) {
          // Found new authhead
          return {
            entry: {
              authbase: authbaseTxid,
              authhead: currentTxid,
              chainLength,
              isActive: true,
              lastCheckedTimestamp: Date.now(),
            },
            queriesUsed,
            cacheHitType: 'partial',
          };
        }

        currentTxid = nextSpendingTx;
        chainLength++;
      }

      // Max chain length exceeded
      return {
        entry: {
          authbase: authbaseTxid,
          authhead: currentTxid,
          chainLength,
          isActive: false,
          lastCheckedTimestamp: Date.now(),
        },
        queriesUsed,
        cacheHitType: 'partial',
      };
    } catch (error) {
      // Error during continuation
      return {
        entry: {
          authbase: authbaseTxid,
          authhead: currentTxid,
          chainLength,
          isActive: false,
          lastCheckedTimestamp: Date.now(),
        },
        queriesUsed,
        cacheHitType: 'partial',
      };
    }
  }

  // NO CACHE: Walk entire chain from authbase
  let currentTxid = authbaseTxid;
  let chainLength = 1;
  const maxChainLength = 1000;
  let queriesUsed = 0;

  try {
    while (chainLength < maxChainLength) {
      const spendingTxid = await getOutputSpendingTx(currentTxid, 0);
      queriesUsed++;

      if (spendingTxid === null) {
        // Output 0 is unspent - this is the authhead
        return {
          entry: {
            authbase: authbaseTxid,
            authhead: currentTxid,
            chainLength,
            isActive: true,
            lastCheckedTimestamp: Date.now(),
          },
          queriesUsed,
          cacheHitType: 'miss',
        };
      }

      // Output 0 is spent, follow the chain
      currentTxid = spendingTxid;
      chainLength++;
    }

    // Hit max chain length
    console.warn(
      `Warning: Authchain exceeded maximum length of ${maxChainLength} for ${authbaseTxid}`
    );
    return {
      entry: {
        authbase: authbaseTxid,
        authhead: currentTxid,
        chainLength,
        isActive: false,
        lastCheckedTimestamp: Date.now(),
      },
      queriesUsed,
      cacheHitType: 'miss',
    };
  } catch (error) {
    // Return the current position with isActive=false to indicate error
    return {
      entry: {
        authbase: authbaseTxid,
        authhead: currentTxid,
        chainLength,
        isActive: false,
        lastCheckedTimestamp: Date.now(),
      },
      queriesUsed,
      cacheHitType: 'miss',
    };
  }
}

/**
 * Fetch all BCMR registries from Chaingraph
 * Uses authchain caching to avoid redundant Fulcrum queries
 *
 * @param options - Optional configuration
 * @param options.useCache - Whether to use cache (default: true)
 * @param options.cachePath - Path to cache file (default: ./bcmr-registries/.authchain-cache.json)
 * @param options.verbose - Enable verbose logging for detailed diagnostics (default: false)
 * @param options.concurrency - Number of parallel authchain resolutions (default: 50)
 */
export async function getBCMRRegistries(options?: {
  useCache?: boolean;
  cachePath?: string;
  verbose?: boolean;
  concurrency?: number;
}): Promise<BCMRRegistry[]> {
  const useCache = options?.useCache !== false;
  const cachePath = options?.cachePath || './bcmr-registries/.authchain-cache.json';
  const verbose = options?.verbose || false;
  const concurrency = options?.concurrency || 50;

  try {
    const CHAINGRAPH_URL = process.env.CHAINGRAPH_URL || '';

    if (!CHAINGRAPH_URL) {
      throw new Error('CHAINGRAPH_URL environment variable is not set');
    }

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

    const response = await fetch(CHAINGRAPH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: BCMR_QUERY,
      }),
    });

    if (!response.ok) {
      throw new Error(`Chaingraph request failed: ${response.status}`);
    }

    const data = (await response.json()) as {
      data?: { search_output_prefix?: BCMROutput[] };
      errors?: Array<{ message: string }>;
    };

    if (data.errors) {
      throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
    }

    const outputs: BCMROutput[] = data.data?.search_output_prefix || [];

    // Filter to keep only first BCMR output per transaction
    const validOutputs = filterFirstOutputOnly(outputs);

    // Build new cache as we process registries
    const newCache = createEmptyCache();
    const registries: BCMRRegistry[] = [];

    // Track detailed cache performance
    let perfectCacheHits = 0;   // Inactive chains (0 queries)
    let goodCacheHits = 0;      // Active chains still unspent (1 query)
    let partialCacheHits = 0;   // Active chains continued from cache (N queries)
    let cacheMisses = 0;        // No cache entry (full walk)
    let totalFulcrumQueries = 0;
    let processedCount = 0;

    console.log(`Resolving authchains for ${validOutputs.length} registries (concurrency: ${concurrency})...`);
    const startTime = Date.now();

    /**
     * Process a single output
     */
    const processOutput = async (output: BCMROutput, index: number): Promise<BCMRRegistry | null> => {
      const parsed = parseBCMRBytecode(output.locking_bytecode);

      if (!parsed) {
        return null;
      }

      // Strip hex prefix from transaction hash
      const txHash = stripHexPrefix(output.transaction_hash);

      // Get parent transaction ID (CashToken category ID)
      const parentTxId = await getParentTxId(txHash);
      if (!parentTxId) {
        if (verbose) {
          console.warn(`Warning: Could not resolve parent txid for authbase ${txHash}, skipping registry`);
        }
        return null; // Skip this registry
      }

      // Resolve authchain with caching
      const authchainResult = await resolveAuthchain(txHash, oldCache);

      // Get block height (if confirmed) - convert string to number
      const blockHeight = output.transaction.block_inclusions[0]?.block.height
        ? parseInt(String(output.transaction.block_inclusions[0].block.height))
        : 0;

      // Check if output is burned (OP_RETURN at index 0)
      const isBurned = isOutputBurned(output);

      return {
        authbase: txHash,
        authhead: authchainResult.entry.authhead,
        tokenId: parentTxId,
        blockHeight,
        hash: parsed.hash,
        uris: parsed.uris,
        isBurned,
        isValid: parsed.uris.length > 0,
        authchainLength: authchainResult.entry.chainLength,
        isAuthheadUnspent: authchainResult.entry.isActive,
        _authchainResult: authchainResult, // Temp field for statistics
      } as any;
    };

    /**
     * Process registries in parallel with concurrency control
     */
    const processBatch = async (batch: BCMROutput[], batchStartIndex: number): Promise<void> => {
      const results = await Promise.all(
        batch.map((output, i) => processOutput(output, batchStartIndex + i))
      );

      // Update statistics and cache
      for (const result of results) {
        if (result) {
          const authchainResult = (result as any)._authchainResult;
          delete (result as any)._authchainResult;

          // Update cache statistics
          totalFulcrumQueries += authchainResult.queriesUsed;

          switch (authchainResult.cacheHitType) {
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
          }

          // Store in new cache
          newCache.entries[result.authbase] = authchainResult.entry;

          // Add to registries
          registries.push(result);

          // Verbose logging
          if (verbose) {
            const hitTypeDesc: Record<string, string> = {
              perfect: 'perfect hit (0 queries)',
              good: `good hit (1 query)`,
              partial: `partial hit (${authchainResult.queriesUsed} queries)`,
              miss: `miss (${authchainResult.queriesUsed} queries)`,
            };

            console.log(
              `  [${processedCount + 1}/${validOutputs.length}] ${result.tokenId.substring(0, 8)}... ${hitTypeDesc[authchainResult.cacheHitType]}`
            );
          }

          processedCount++;
        } else {
          processedCount++;
        }
      }

      // Progress reporting
      if (processedCount % 100 === 0 || processedCount === validOutputs.length) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const rate = ((processedCount / (Date.now() - startTime)) * 1000).toFixed(1);
        console.log(`  Resolving authchains... ${processedCount}/${validOutputs.length} (${elapsed}s, ${rate} reg/s)`);
      }
    };

    // Process in batches with concurrency control
    for (let i = 0; i < validOutputs.length; i += concurrency) {
      const batch = validOutputs.slice(i, i + concurrency);
      await processBatch(batch, i);
    }

    const endTime = Date.now();
    const durationSeconds = ((endTime - startTime) / 1000).toFixed(2);
    const avgTimePerRegistry = ((endTime - startTime) / validOutputs.length).toFixed(0);

    console.log(`Authchain resolution complete in ${durationSeconds}s (avg ${avgTimePerRegistry}ms per registry)`);

    // Display detailed cache statistics
    if (useCache) {
      const totalHits = perfectCacheHits + goodCacheHits + partialCacheHits;
      const totalRegistries = totalHits + cacheMisses;

      console.log('\nCache Performance:');
      console.log(`  Perfect hits: ${perfectCacheHits} (0 queries each)`);
      console.log(`  Good hits: ${goodCacheHits} (1 query each)`);
      console.log(`  Partial hits: ${partialCacheHits} (continued from cache)`);
      console.log(`  Misses: ${cacheMisses} (full authchain walk)`);
      console.log(`  Total: ${totalHits}/${totalRegistries} cached (${((totalHits / totalRegistries) * 100).toFixed(1)}%)`);

      console.log('\nFulcrum Query Statistics:');
      console.log(`  Total queries: ${totalFulcrumQueries}`);
      console.log(`  Average per registry: ${(totalFulcrumQueries / validOutputs.length).toFixed(2)}`);

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
 * Check if a hostname is an internal/private address
 * SECURITY: Prevents SSRF attacks targeting internal services
 */
function isInternalHostname(hostname: string): boolean {
  // Localhost patterns
  if (/^(localhost|127\.|::1)$/i.test(hostname)) {
    return true;
  }

  // Private IPv4 ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
  if (/^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)/.test(hostname)) {
    return true;
  }

  // Link-local addresses (169.254.0.0/16, fe80::/10)
  if (/^(169\.254\.|fe80:)/i.test(hostname)) {
    return true;
  }

  // Private IPv6 ranges (fc00::/7, fd00::/8)
  if (/^(fc00:|fd00:)/i.test(hostname)) {
    return true;
  }

  return false;
}

/**
 * Normalize URI to a clickable HTTP(S) URL
 * - ipfs:// URIs are converted to IPFS gateway URLs
 * - URIs without protocol are assumed to be HTTPS per BCMR spec
 * - http:// and https:// URIs are validated for security
 * SECURITY: Blocks internal/private addresses to prevent SSRF attacks
 */
export function normalizeUri(uri: string): string {
  if (uri.startsWith('ipfs://')) {
    const hash = uri.replace('ipfs://', '');
    return `https://ipfs.io/ipfs/${hash}`;
  }

  // If URI already has a protocol
  if (uri.startsWith('https://') || uri.startsWith('http://')) {
    try {
      const url = new URL(uri);

      // SECURITY: Block internal/private hostnames
      if (isInternalHostname(url.hostname)) {
        throw new Error(`Internal/private hostnames not allowed: ${url.hostname}`);
      }

      // SECURITY: Only allow standard HTTP(S) ports or no port specified
      if (url.port && !['', '80', '443'].includes(url.port)) {
        throw new Error(`Non-standard ports not allowed: ${url.port}`);
      }

      return uri;
    } catch (error) {
      throw new Error(`Invalid or unsafe URI: ${error instanceof Error ? error.message : error}`);
    }
  }

  // Per BCMR spec: URIs without protocol prefix assume HTTPS
  const httpsUri = `https://${uri}`;
  try {
    const url = new URL(httpsUri);

    // SECURITY: Block internal/private hostnames
    if (isInternalHostname(url.hostname)) {
      throw new Error(`Internal/private hostnames not allowed: ${url.hostname}`);
    }

    return httpsUri;
  } catch (error) {
    throw new Error(`Invalid URI format: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Legacy alias for backward compatibility
 */
export function ipfsToGateway(uri: string): string {
  return normalizeUri(uri);
}

/**
 * Fetch and validate a BCMR registry JSON from URIs
 * Tries each URI in order until one succeeds
 *
 * @param uris - Array of URIs to try (IPFS and HTTPS)
 * @param expectedHash - Expected SHA-256 hash of the JSON content
 * @param maxRetries - Maximum number of retries per URI (default: 2)
 * @param timeoutMs - Timeout in milliseconds (default: 2000)
 * @returns Object with parsed JSON and raw content if valid, null if all attempts fail or hash mismatch
 */
export async function fetchAndValidateRegistry(
  uris: string[],
  expectedHash: string,
  maxRetries: number = 2,
  timeoutMs: number = 2000
): Promise<{ json: any; rawContent: string } | null> {
  for (const uri of uris) {
    // Convert IPFS URIs to gateway URLs
    const fetchUrl = normalizeUri(uri);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Create abort controller for timeout
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        // Fetch the JSON
        const response = await fetch(fetchUrl, {
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!response.ok) {
          console.warn(
            `Failed to fetch ${fetchUrl} (attempt ${attempt}/${maxRetries}): HTTP ${response.status}`
          );
          continue;
        }

        // Get raw text content
        const rawContent = await response.text();

        // Compute SHA-256 hash
        const computedHash = createHash('sha256').update(rawContent).digest('hex');

        // Verify hash matches
        if (computedHash !== expectedHash) {
          console.warn(
            `Hash mismatch for ${fetchUrl}: expected ${expectedHash}, got ${computedHash}`
          );
          return null; // Hash mismatch - don't retry, this is invalid
        }

        // Parse JSON
        try {
          const json = JSON.parse(rawContent);

          // Basic structure validation - must have identities object
          if (!json || typeof json !== 'object' || !json.identities) {
            console.warn(`Invalid BCMR structure from ${fetchUrl}: missing identities object`);
            return null;
          }

          // Success! Return both parsed JSON and raw content
          return { json, rawContent };
        } catch (parseError) {
          console.warn(`JSON parse error from ${fetchUrl}:`, parseError);
          return null; // Invalid JSON - don't retry
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          console.warn(
            `Timeout fetching ${fetchUrl} (attempt ${attempt}/${maxRetries})`
          );
        } else {
          console.warn(
            `Error fetching ${fetchUrl} (attempt ${attempt}/${maxRetries}):`,
            error instanceof Error ? error.message : error
          );
        }

        // Wait before retry with exponential backoff
        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, attempt - 1)));
        }
      }
    }
  }

  // All URIs and retries failed
  return null;
}
