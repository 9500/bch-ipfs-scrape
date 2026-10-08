/**
 * User-configured IPFS gateway settings (command-line flags and mapping files)
 */

import { readFileSync, existsSync } from 'fs';

/**
 * Normalize a user-configured gateway (a rewrite destination or the default
 * ipfs:// gateway). An explicit `http://` is kept so plain-HTTP gateways such
 * as a local Kubo daemon can be reached; `https://` is the default and is
 * dropped. Trailing slashes are removed and the value is lowercased.
 *
 * @param gateway - Gateway (e.g. "ipfs.io", "https://ipfs.io/", "http://192.168.1.100:8080")
 * @returns "host[:port]" for https gateways, "http://host[:port]" for http gateways
 */
export function normalizeGatewayDomain(gateway: string): string {
  let normalized = gateway.trim();

  // https:// is the default scheme, so it carries no information
  normalized = normalized.replace(/^https:\/\//i, '');

  // Strip trailing slashes
  normalized = normalized.replace(/\/+$/, '');

  // Convert to lowercase for case-insensitive matching (schemes and hosts are case-insensitive)
  normalized = normalized.toLowerCase();

  return normalized;
}

/**
 * Normalize a gateway for matching against URLs found on the blockchain
 * (a rewrite source). The scheme is irrelevant for matching, so both
 * `http://` and `https://` are dropped.
 *
 * @returns "host[:port]", lowercased, without scheme or trailing slashes
 */
export function normalizeGatewayHost(gateway: string): string {
  return normalizeGatewayDomain(gateway).replace(/^http:\/\//, '');
}

/**
 * Load gateway mapping from JSON file
 * Format: { "source-gateway.com": "dest-gateway.com" }
 * Sources are matched by host (any scheme is dropped); destinations keep an
 * explicit http:// so plain-HTTP gateways can be targeted.
 * Supports private IPs and localhost in destinations (user-configured = trusted)
 * @param filepath - Path to JSON mapping file
 * @returns Map of source gateway -> destination gateway
 */
export function loadGatewayMapping(filepath: string): Map<string, string> {
  // Check file exists
  if (!existsSync(filepath)) {
    throw new Error(`Gateway mapping file not found: ${filepath}`);
  }

  // Read and parse JSON
  const content = readFileSync(filepath, 'utf-8');
  let json: unknown;

  try {
    json = JSON.parse(content);
  } catch (e) {
    throw new Error(`Invalid JSON in gateway mapping file: ${filepath}`);
  }

  // Validate it's an object (not array)
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new Error(`Gateway mapping must be a JSON object, not array or primitive`);
  }

  // Build mapping with normalized keys and values
  const mapping = new Map<string, string>();

  for (const [source, dest] of Object.entries(json)) {
    if (typeof dest !== 'string') {
      throw new Error(`Gateway mapping values must be strings. Invalid value for "${source}": ${dest}`);
    }

    const normalizedSource = normalizeGatewayHost(source);
    const normalizedDest = normalizeGatewayDomain(dest);

    if (normalizedSource.length === 0) {
      throw new Error(`Empty source gateway after normalization: "${source}"`);
    }

    if (normalizedDest.length === 0) {
      throw new Error(`Empty destination gateway after normalization: "${dest}"`);
    }

    mapping.set(normalizedSource, normalizedDest);
  }

  return mapping;
}

