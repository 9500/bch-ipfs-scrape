/**
 * Validation Cache Management
 * Caches JSON schema validation results to avoid re-validating known-invalid content
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

/**
 * Cache entry for a single JSON validation result
 */
export interface ValidationCacheEntry {
  hash: string;                // SHA-256 hash of JSON content
  url: string;                 // URL where JSON was found
  isValid: boolean;            // Schema validation result
  validationErrors?: string[]; // Specific schema validation errors
  lastChecked: number;         // Unix timestamp of last validation
  attemptCount: number;        // Number of validation attempts
}

/**
 * Complete validation cache structure
 */
export interface ValidationCache {
  version: number;  // Cache format version (for future migrations)
  entries: Record<string, ValidationCacheEntry>; // Keyed by JSON hash
}

/**
 * Create an empty cache
 */
export function createEmptyCache(): ValidationCache {
  return {
    version: 1,
    entries: {},
  };
}

/**
 * Load validation cache from disk
 * Returns empty cache if file doesn't exist or is corrupted
 */
export function loadValidationCache(cachePath: string): ValidationCache {
  try {
    const fileContent = readFileSync(cachePath, 'utf-8');
    const cache = JSON.parse(fileContent) as ValidationCache;

    // Validate cache structure
    if (!cache.version || typeof cache.version !== 'number') {
      console.warn('Invalid validation cache version, creating new cache');
      return createEmptyCache();
    }

    if (!cache.entries || typeof cache.entries !== 'object') {
      console.warn('Invalid validation cache entries, creating new cache');
      return createEmptyCache();
    }

    // Check for version compatibility
    if (cache.version !== 1) {
      console.warn(`Unsupported validation cache version ${cache.version}, creating new cache`);
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
      `Failed to load validation cache: ${error instanceof Error ? error.message : error}`
    );
    console.warn('Creating new validation cache');
    return createEmptyCache();
  }
}

/**
 * Save validation cache to disk (atomic operation)
 */
export function saveValidationCache(cache: ValidationCache, cachePath: string): void {
  try {
    // Ensure the directory exists
    const dir = dirname(cachePath);
    mkdirSync(dir, { recursive: true });

    const jsonContent = JSON.stringify(cache, null, 2);
    writeFileSync(cachePath, jsonContent, 'utf-8');
  } catch (error) {
    console.error(
      `Failed to save validation cache: ${error instanceof Error ? error.message : error}`
    );
    throw error;
  }
}

/**
 * Get cache statistics for logging
 */
export function getCacheStats(cache: ValidationCache): {
  totalEntries: number;
  validEntries: number;
  invalidEntries: number;
} {
  const entries = Object.values(cache.entries);
  const validEntries = entries.filter((e) => e.isValid).length;
  const invalidEntries = entries.filter((e) => !e.isValid).length;

  return {
    totalEntries: entries.length,
    validEntries,
    invalidEntries,
  };
}
