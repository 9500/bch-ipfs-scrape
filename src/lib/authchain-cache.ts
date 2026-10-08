/**
 * Authchain Cache Management
 * Caches authchain resolution results to avoid redundant Fulcrum queries
 */

import { readFileSync } from 'fs';
import { writeFileAtomic } from './atomic-write.js';

/**
 * Cache entry for a single authchain
 */
export interface AuthchainCacheEntry {
  authbase: string;              // Transaction hash (authchain start)
  authhead: string;              // Current authhead txid
  chainLength: number;           // Number of hops in chain
  isActive: boolean;             // Whether authhead output 0 is unspent
  lastCheckedTimestamp: number;  // Unix timestamp of last check
  parentTxId?: string;           // Txid spent by input 0 (token category); never changes
}

/**
 * Complete authchain cache structure
 */
export interface AuthchainCache {
  version: number;  // Cache format version (for future migrations)
  entries: Record<string, AuthchainCacheEntry>; // Keyed by authbase txid
}

/**
 * Current cache format version.
 * Version 2: entries are only written for walks that completed, so an
 * inactive entry always means "exceeded maximum chain length". Version 1
 * caches also stored walks aborted by backend errors as inactive entries
 * with a wrong authhead, so they are discarded.
 */
export const CACHE_VERSION = 2;

/**
 * Create an empty cache
 */
export function createEmptyCache(): AuthchainCache {
  return {
    version: CACHE_VERSION,
    entries: {},
  };
}

/**
 * Load authchain cache from disk
 * Returns empty cache if file doesn't exist or is corrupted
 */
export function loadAuthchainCache(cachePath: string): AuthchainCache {
  try {
    const fileContent = readFileSync(cachePath, 'utf-8');
    const cache = JSON.parse(fileContent) as AuthchainCache;

    // Validate cache structure
    if (!cache.version || typeof cache.version !== 'number') {
      console.warn('Invalid cache version, creating new cache');
      return createEmptyCache();
    }

    if (!cache.entries || typeof cache.entries !== 'object') {
      console.warn('Invalid cache entries, creating new cache');
      return createEmptyCache();
    }

    // Check for version compatibility
    if (cache.version !== CACHE_VERSION) {
      console.warn(
        `Authchain cache version ${cache.version} is not supported (current: ${CACHE_VERSION}); rebuilding the cache`
      );
      return createEmptyCache();
    }

    return cache;
  } catch (error) {
    // File doesn't exist or is corrupted
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      // File doesn't exist - this is normal for first run
      return createEmptyCache();
    }

    // Other errors (parse errors, permission issues, etc.)
    console.warn(
      `Failed to load cache: ${error instanceof Error ? error.message : error}`
    );
    console.warn('Creating new cache');
    return createEmptyCache();
  }
}

/**
 * Save authchain cache to disk (atomic operation)
 * Only saves if all validations completed successfully
 */
export function saveAuthchainCache(cache: AuthchainCache, cachePath: string): void {
  try {
    // Written to a temporary file and renamed into place, so a crash never
    // leaves a truncated cache behind
    writeFileAtomic(cachePath, JSON.stringify(cache, null, 2));
  } catch (error) {
    console.error(
      `Failed to save cache: ${error instanceof Error ? error.message : error}`
    );
    throw error;
  }
}

/**
 * Get cache statistics for logging
 */
export function getCacheStats(cache: AuthchainCache): {
  totalEntries: number;
  activeEntries: number;
  inactiveEntries: number;
} {
  const entries = Object.values(cache.entries);
  const activeEntries = entries.filter((e) => e.isActive).length;
  const inactiveEntries = entries.filter((e) => !e.isActive).length;

  return {
    totalEntries: entries.length,
    activeEntries,
    inactiveEntries,
  };
}
