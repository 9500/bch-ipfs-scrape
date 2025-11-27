#!/usr/bin/env node
/**
 * BCMR Registry Tool
 * Console application to resolve, export, and fetch Bitcoin Cash Metadata Registries
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync, unlinkSync, statSync, readdirSync } from 'fs';
import { getBCMRRegistries, fetchAndValidateRegistry } from './lib/bcmr.js';
import { closeConnectionPool } from './lib/fulcrum-client.js';
import * as dotenv from 'dotenv';
import { join } from 'path';
import { createHash } from 'crypto';
import { execSync, spawn } from 'child_process';
import { CID } from 'multiformats/cid';

// Get package version (works in both ESM and bundled CommonJS)
let VERSION = '1.0.0'; // Fallback version
try {
  // Try to read from package.json (works when running from source)
  const packageJsonPath = new URL('../package.json', import.meta.url);
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  VERSION = packageJson.version;
} catch (e) {
  // Fallback for bundled version - version is hardcoded above
}

// Load environment variables
dotenv.config();

/**
 * Get the working directory from environment variable
 * If BCMR_WORKDIR is set, all file paths will be relative to this directory
 */
function getWorkDir(): string | null {
  return process.env.BCMR_WORKDIR || null;
}

/**
 * Resolve a path relative to the work directory if specified
 * If BCMR_WORKDIR is not set, returns the path as-is (relative to current directory)
 * @param relativePath - The relative path to resolve
 * @returns Absolute or relative path depending on BCMR_WORKDIR
 */
function resolveWorkPath(relativePath: string): string {
  const workDir = getWorkDir();
  if (workDir) {
    return join(workDir, relativePath);
  }
  return relativePath;
}

/**
 * Registry entry in authhead.json (active registries only)
 */
interface AuthheadRegistry {
  tokenId: string;
  authbase: string;
  authhead: string;
  blockHeight: number;
  hash: string;
  uris: string[];
  authchainLength: number;
  isActive: boolean;
  isBurned: boolean;
  isValid: boolean;
}

/**
 * Parse command line arguments
 */
function parseArgs(): {
  authchainResolve: boolean;
  queryChaingraph: boolean;
  export: string | null;
  exportBcmrIpfsCids: boolean;
  exportCashtokenIpfsCids: boolean;
  fetchJson: boolean;
  fetchValidJson: boolean;
  ipfsPin: boolean;
  ignoreJsonHash: boolean;
  authheadFile: string;
  exportFile: string;
  cidsFile: string;
  cashtokenCidsFile: string;
  ipfsPinCidsFile: string | null;
  ipfsPinConcurrency: number;
  jsonFolder: string;
  jsonConcurrency: number;
  maxFileSizeMB: number;
  ipfsPinTimeout: number;
  useCache: boolean;
  clearCache: boolean;
  verbose: boolean;
  concurrency: number;
  showHelp: boolean;
  showVersion: boolean;
  chaingraphQueryFile: string | null;
  chaingraphResultFile: string;
} {
  const args = process.argv.slice(2);
  let authchainResolve = false;
  let queryChaingraph = false;
  let exportProtocols: string | null = null;
  let exportBcmrIpfsCids = false;
  let exportCashtokenIpfsCids = false;
  let fetchJson = false;
  let fetchValidJson = false;
  let ipfsPin = false;
  let ignoreJsonHash = false;
  let authheadFile = resolveWorkPath('./authhead.json');
  let exportFile = resolveWorkPath('exported-urls.txt');
  let cidsFile = resolveWorkPath('bcmr-ipfs-cids.txt');
  let cashtokenCidsFile = resolveWorkPath('cashtoken-ipfs-cids.txt');
  let ipfsPinCidsFile: string | null = null; // null = pin both files by default
  let ipfsPinConcurrency = 5; // Default: 5 concurrent pins
  let jsonFolder = resolveWorkPath('./bcmr-registries');
  let jsonConcurrency = 10; // Default: 10 concurrent downloads
  let maxFileSizeMB = 50; // Default: 50MB
  let ipfsPinTimeout = 5; // Default: 5 seconds
  let useCache = true;
  let clearCache = false;
  let verbose = false;
  let concurrency = 50;
  let showHelp = false;
  let showVersion = false;
  let chaingraphQueryFile: string | null = null;
  let chaingraphResultFile = resolveWorkPath('./chaingraph-result.json');

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--authchain-resolve') {
      authchainResolve = true;
    } else if (arg === '--query-chaingraph') {
      queryChaingraph = true;
      // Check if next arg is a file path (doesn't start with --)
      if (args[i + 1] && !args[i + 1].startsWith('--')) {
        chaingraphQueryFile = args[i + 1];
        i++;
      }
    } else if (arg === '--chaingraph-result-file') {
      chaingraphResultFile = args[i + 1];
      if (!chaingraphResultFile) {
        console.error('Error: --chaingraph-result-file requires a path');
        process.exit(1);
      }
      i++;
    } else if (arg === '--export') {
      exportProtocols = args[i + 1];
      if (!exportProtocols) {
        console.error('Error: --export requires protocol list (IPFS, HTTPS, OTHER, ALL)');
        process.exit(1);
      }
      i++;
    } else if (arg === '--fetch-json') {
      fetchJson = true;
    } else if (arg === '--fetch-valid-json') {
      fetchValidJson = true;
    } else if (arg === '--ignore-json-hash') {
      ignoreJsonHash = true;
    } else if (arg === '--json-concurrency') {
      const concurrencyValue = parseInt(args[i + 1]);
      if (isNaN(concurrencyValue) || concurrencyValue < 1 || concurrencyValue > 200) {
        console.error('Error: --json-concurrency must be a number between 1 and 200');
        process.exit(1);
      }
      jsonConcurrency = concurrencyValue;
      i++;
    } else if (arg === '--export-bcmr-ipfs-cids') {
      exportBcmrIpfsCids = true;
    } else if (arg === '--export-cashtoken-ipfs-cids') {
      exportCashtokenIpfsCids = true;
    } else if (arg === '--ipfs-pin') {
      ipfsPin = true;
    } else if (arg === '--authhead-file') {
      authheadFile = args[i + 1];
      if (!authheadFile) {
        console.error('Error: --authhead-file requires a path');
        process.exit(1);
      }
      i++;
    } else if (arg === '--export-file') {
      exportFile = args[i + 1];
      if (!exportFile) {
        console.error('Error: --export-file requires a filename');
        process.exit(1);
      }
      i++;
    } else if (arg === '--cids-file') {
      cidsFile = args[i + 1];
      if (!cidsFile) {
        console.error('Error: --cids-file requires a filename');
        process.exit(1);
      }
      i++;
    } else if (arg === '--cashtoken-cids-file') {
      cashtokenCidsFile = args[i + 1];
      if (!cashtokenCidsFile) {
        console.error('Error: --cashtoken-cids-file requires a filename');
        process.exit(1);
      }
      i++;
    } else if (arg === '--ipfs-pin-file') {
      ipfsPinCidsFile = args[i + 1];
      if (!ipfsPinCidsFile) {
        console.error('Error: --ipfs-pin-file requires a filename');
        process.exit(1);
      }
      i++;
    } else if (arg === '--ipfs-pin-timeout') {
      const timeoutValue = parseInt(args[i + 1]);
      if (isNaN(timeoutValue) || timeoutValue < 1 || timeoutValue > 600) {
        console.error('Error: --ipfs-pin-timeout must be a number between 1 and 600 seconds');
        process.exit(1);
      }
      ipfsPinTimeout = timeoutValue;
      i++;
    } else if (arg === '--ipfs-pin-concurrency') {
      const concurrencyValue = parseInt(args[i + 1]);
      if (isNaN(concurrencyValue) || concurrencyValue < 1 || concurrencyValue > 200) {
        console.error('Error: --ipfs-pin-concurrency must be a number between 1 and 200');
        process.exit(1);
      }
      ipfsPinConcurrency = concurrencyValue;
      i++;
    } else if (arg === '--json-folder') {
      jsonFolder = args[i + 1];
      if (!jsonFolder) {
        console.error('Error: --json-folder requires a path');
        process.exit(1);
      }
      i++;
    } else if (arg === '--no-cache') {
      useCache = false;
    } else if (arg === '--clear-cache') {
      clearCache = true;
    } else if (arg === '--verbose' || arg === '-v') {
      verbose = true;
    } else if (arg === '--concurrency' || arg === '-c') {
      const concurrencyValue = parseInt(args[i + 1]);
      if (isNaN(concurrencyValue) || concurrencyValue < 1 || concurrencyValue > 200) {
        console.error('Error: --concurrency must be a number between 1 and 200');
        process.exit(1);
      }
      concurrency = concurrencyValue;
      i++;
    } else if (arg === '--max-file-size-mb') {
      const maxSizeValue = parseInt(args[i + 1]);
      if (isNaN(maxSizeValue) || maxSizeValue < 1 || maxSizeValue > 1000) {
        console.error('Error: --max-file-size-mb must be a number between 1 and 1000');
        process.exit(1);
      }
      maxFileSizeMB = maxSizeValue;
      i++;
    } else if (arg === '--version') {
      showVersion = true;
    } else if (arg === '--help' || arg === '-h') {
      showHelp = true;
    } else {
      console.error(`Error: Unknown argument "${arg}"`);
      printUsage();
      process.exit(1);
    }
  }

  return {
    authchainResolve,
    queryChaingraph,
    export: exportProtocols,
    exportBcmrIpfsCids,
    exportCashtokenIpfsCids,
    fetchJson,
    fetchValidJson,
    ipfsPin,
    ignoreJsonHash,
    authheadFile,
    exportFile,
    cidsFile,
    cashtokenCidsFile,
    ipfsPinCidsFile,
    ipfsPinConcurrency,
    jsonFolder,
    jsonConcurrency,
    maxFileSizeMB,
    ipfsPinTimeout,
    useCache,
    clearCache,
    verbose,
    concurrency,
    showHelp,
    showVersion,
    chaingraphQueryFile,
    chaingraphResultFile,
  };
}

/**
 * Print usage information
 */
function printUsage(): void {
  console.log(`
BCMR Registry Tool

Usage: bch-ipfs-scrape [command] [options]

Commands:
  --query-chaingraph [file]     Query Chaingraph and save raw results to file
                                Optional: provide custom GraphQL query file
                                If no query file specified, uses default BCMR query
  --authchain-resolve           Resolve authchains from Chaingraph result file and save to authhead.json
                                (requires --query-chaingraph to be run first)
  --export <protocols>          Export URLs from authhead.json (IPFS, HTTPS, OTHER, ALL)
  --export-bcmr-ipfs-cids       Export IPFS CIDs from authhead.json (deduplicated, sorted)
  --export-cashtoken-ipfs-cids  Extract IPFS CIDs from BCMR JSON files (deduplicated, sorted)
  --fetch-json                  Fetch BCMR JSON files from authhead.json (no validation)
  --fetch-valid-json            Fetch and validate BCMR JSON files against BCMR schema
                                (caches invalid files to avoid re-downloading)
  --ipfs-pin                    Pin IPFS CIDs from both default files using local IPFS daemon
                                (uses cache to skip already-pinned CIDs)

Options:
  --chaingraph-result-file <path>  Path to save/load Chaingraph results (default: ./chaingraph-result.json)
  --authhead-file <path>        Path to authhead.json (default: ./authhead.json)
  --export-file <filename>      Export output filename (default: exported-urls.txt)
  --cids-file <filename>        BCMR CIDs output filename (default: bcmr-ipfs-cids.txt)
  --cashtoken-cids-file <file>  Cashtoken CIDs output filename (default: cashtoken-ipfs-cids.txt)
  --ipfs-pin-file <filename>    CIDs file to pin (default: both bcmr-ipfs-cids.txt and cashtoken-ipfs-cids.txt)
  --ipfs-pin-timeout <seconds>  Timeout per CID in seconds (1-600, default: 5)
  --ipfs-pin-concurrency <num>  Parallel pin concurrency (1-200, default: 5)
  --json-folder <path>          Folder for cache and BCMR JSON (default: ./bcmr-registries)
  --json-concurrency <num>      Parallel JSON download concurrency (1-200, default: 10)
  --max-file-size-mb <num>      Max JSON file size in MB (1-1000, default: 50)
  --ignore-json-hash            Store JSON files even if hash verification fails
                                (computed hash still used for validation cache)
  --no-cache                    Disable authchain caching (force full resolution)
  --clear-cache                 Delete cache before running
  --concurrency, -c <num>       Parallel query concurrency (1-200, default: 50)
  --verbose, -v                 Enable verbose logging for detailed diagnostics
  --version                     Show version number
  --help, -h                    Show this help message

Workflow Examples:

  1. New two-step workflow (query then resolve):
     bch-ipfs-scrape --query-chaingraph
     bch-ipfs-scrape --authchain-resolve

  2. Query with custom GraphQL query file:
     bch-ipfs-scrape --query-chaingraph custom-query.graphql

  3. Combined query and resolve in one command:
     bch-ipfs-scrape --query-chaingraph --authchain-resolve

  4. Export IPFS URLs from authhead.json:
     bch-ipfs-scrape --export IPFS

  5. Export multiple protocol types:
     bch-ipfs-scrape --export IPFS,HTTPS --export-file all-urls.txt

  6. Export IPFS CIDs from authhead.json (deduplicated and sorted):
     bch-ipfs-scrape --export-bcmr-ipfs-cids

  7. Extract IPFS CIDs from BCMR JSON files:
     bch-ipfs-scrape --export-cashtoken-ipfs-cids

  8. Fetch BCMR JSON files (without validation):
     bch-ipfs-scrape --fetch-json

  9. Fetch and validate BCMR JSON files (with schema validation):
     bch-ipfs-scrape --fetch-valid-json
     bch-ipfs-scrape --fetch-valid-json --json-concurrency 20  # faster with more parallelism

  10. Pin IPFS CIDs using local IPFS daemon (pins from both CID files by default):
      bch-ipfs-scrape --ipfs-pin
      bch-ipfs-scrape --ipfs-pin --ipfs-pin-file bcmr-ipfs-cids.txt  # pin only BCMR CIDs
      bch-ipfs-scrape --ipfs-pin --ipfs-pin-timeout 10

  11. Combined workflow (export and pin):
      bch-ipfs-scrape --export-bcmr-ipfs-cids --export-cashtoken-ipfs-cids --ipfs-pin

  12. Full workflow with validation (all in one):
      bch-ipfs-scrape --query-chaingraph --authchain-resolve --fetch-valid-json --export-bcmr-ipfs-cids --export-cashtoken-ipfs-cids --ipfs-pin

  13. Custom result file location:
      bch-ipfs-scrape --query-chaingraph --chaingraph-result-file ./data/chaingraph.json
      bch-ipfs-scrape --authchain-resolve --chaingraph-result-file ./data/chaingraph.json

Protocol Filters:
  IPFS   - IPFS URIs (ipfs://)
  HTTPS  - HTTP and HTTPS URIs (http://, https://)
  OTHER  - Other protocols (dweb://, etc.)
  ALL    - All URIs regardless of protocol

Environment Variables:
  CHAINGRAPH_URL    GraphQL endpoint for Chaingraph (required for --query-chaingraph)
  FULCRUM_WS_URL    Fulcrum WebSocket endpoint for authchain resolution (required for --authchain-resolve)
  BCMR_WORKDIR      Working directory for all output files (optional)
                    If set, all files/folders will be saved relative to this directory
                    If not set, files are saved in the current working directory

Notes:
  The new workflow separates Chaingraph querying from authchain resolution.
  This allows users to:
    - Use custom Chaingraph queries to influence input data
    - Inspect/modify Chaingraph results before processing
    - Re-run authchain resolution without re-querying Chaingraph
  Adjust --concurrency (1-200) to balance server load.
  Use --verbose to see detailed cache hit/miss information per registry.
`);
}

/**
 * Load authhead.json file
 */
function loadAuthheadFile(authheadFile: string): AuthheadRegistry[] {
  if (!existsSync(authheadFile)) {
    console.error(`Error: ${authheadFile} not found. Run with --authchain-resolve first.`);
    process.exit(1);
  }

  try {
    const fileContent = readFileSync(authheadFile, 'utf-8');
    const data = sanitizeJSON(JSON.parse(fileContent));

    // Validate structure
    if (!Array.isArray(data)) {
      console.error(`Error: Invalid ${authheadFile} format (expected array). Please run --authchain-resolve again.`);
      process.exit(1);
    }

    // Basic validation of entries
    for (const entry of data) {
      if (!entry.tokenId || !entry.uris || !Array.isArray(entry.uris)) {
        console.error(`Error: Invalid ${authheadFile} format (missing required fields). Please run --authchain-resolve again.`);
        process.exit(1);
      }
    }

    return data as AuthheadRegistry[];
  } catch (error) {
    console.error(`Error: Failed to read ${authheadFile}: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

/**
 * Classify URL protocol
 */
function classifyUrlProtocol(url: string): 'IPFS' | 'HTTPS' | 'OTHER' {
  if (url.startsWith('ipfs://')) {
    return 'IPFS';
  } else if (url.startsWith('https://') || url.startsWith('http://')) {
    return 'HTTPS';
  } else {
    return 'OTHER';
  }
}

/**
 * Parse protocols filter string
 */
function parseProtocolsFilter(protocolsStr: string): Set<'IPFS' | 'HTTPS' | 'OTHER' | 'ALL'> {
  const protocols = protocolsStr.split(',').map((p) => p.trim().toUpperCase());
  const validProtocols: Set<'IPFS' | 'HTTPS' | 'OTHER' | 'ALL'> = new Set();

  for (const protocol of protocols) {
    if (protocol === 'IPFS' || protocol === 'HTTPS' || protocol === 'OTHER' || protocol === 'ALL') {
      validProtocols.add(protocol as 'IPFS' | 'HTTPS' | 'OTHER' | 'ALL');
    } else {
      console.error(`Error: Unknown protocol '${protocol}'. Valid: IPFS, HTTPS, OTHER, ALL`);
      process.exit(1);
    }
  }

  if (validProtocols.size === 0) {
    console.error('Error: --export requires at least one protocol (IPFS, HTTPS, OTHER, ALL)');
    process.exit(1);
  }

  return validProtocols;
}

/**
 * Sanitize tokenId to prevent path traversal attacks
 * TokenIds should be 64-character hex strings (transaction hashes)
 * @throws Error if tokenId is invalid
 */
function sanitizeTokenId(tokenId: string): string {
  // Only allow 64-character hex strings (SHA-256 transaction hashes)
  if (!/^[a-fA-F0-9]{64}$/.test(tokenId)) {
    throw new Error(`Invalid tokenId format: ${tokenId.substring(0, 20)}...`);
  }
  return tokenId;
}

/**
 * Sanitize parsed JSON to prevent prototype pollution
 * Removes dangerous keys like __proto__, constructor, prototype
 * SECURITY: Prevents prototype pollution attacks from malicious JSON
 */
function sanitizeJSON(obj: any): any {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(sanitizeJSON);
  }

  // Remove dangerous keys
  const dangerousKeys = ['__proto__', 'constructor', 'prototype'];
  for (const key of dangerousKeys) {
    delete obj[key];
  }

  // Recursively sanitize nested objects
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      if (dangerousKeys.includes(key)) {
        delete obj[key];
      } else {
        obj[key] = sanitizeJSON(obj[key]);
      }
    }
  }

  return obj;
}

/**
 * Validate if a string is a valid IPFS CID (v0 or v1)
 * Uses multiformats library for accurate validation
 */
function isValidIPFSCID(cid: string): boolean {
  // Remove any whitespace
  cid = cid.trim();

  // Check for empty string
  if (!cid || cid.length === 0) {
    return false;
  }

  // Use multiformats library to validate CID
  try {
    CID.parse(cid);
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract CIDs from URL (ipfs:// scheme or HTTPS gateway URLs)
 * Supports:
 * - ipfs://CID/path -> [CID]
 * - https://gateway.com/ipfs/CID/path -> [CID]
 * - https://CID.ipfs.gateway.com/path -> [CID]
 * Skips IPNS URLs (returns empty array)
 */
function extractCIDsFromURL(url: string): string[] {
  const cids: string[] = [];

  try {
    // Skip IPNS URLs (we only want IPFS CIDs)
    if (url.includes('/ipns/') || url.includes('.ipns.')) {
      return [];
    }

    // Handle ipfs:// scheme
    if (url.startsWith('ipfs://')) {
      const cidPart = url.substring(7).split('/')[0];
      if (cidPart.length > 0 && isValidIPFSCID(cidPart)) {
        cids.push(cidPart);
      }
      return cids;
    }

    // Handle HTTPS gateway URLs
    if (url.startsWith('http://') || url.startsWith('https://')) {
      // Path-style: https://gateway.com/ipfs/CID/path
      const pathMatch = url.match(/\/ipfs\/([^/?#]+)/);
      if (pathMatch && pathMatch[1]) {
        const cidPart = pathMatch[1];
        if (isValidIPFSCID(cidPart)) {
          cids.push(cidPart);
        }
      }

      // Subdomain-style: https://CID.ipfs.gateway.com/path
      const subdomainMatch = url.match(/^https?:\/\/([^./]+)\.ipfs\./);
      if (subdomainMatch && subdomainMatch[1]) {
        const cidPart = subdomainMatch[1];
        if (isValidIPFSCID(cidPart)) {
          cids.push(cidPart);
        }
      }
    }
  } catch {
    // URL parsing failed, return empty array
  }

  return cids;
}

/**
 * Command: Query Chaingraph and save raw results to file
 */
async function doQueryChaingraph(options: {
  chaingraphQueryFile: string | null;
  chaingraphResultFile: string;
}): Promise<void> {
  const { chaingraphQueryFile, chaingraphResultFile } = options;

  // Default GraphQL query for BCMR outputs
  const DEFAULT_BCMR_QUERY = `
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

  // Load query from file or use default
  let query: string;
  if (chaingraphQueryFile) {
    console.log(`Loading custom Chaingraph query from ${chaingraphQueryFile}...`);
    if (!existsSync(chaingraphQueryFile)) {
      console.error(`Error: Query file not found: ${chaingraphQueryFile}`);
      process.exit(1);
    }
    try {
      query = readFileSync(chaingraphQueryFile, 'utf-8');
      console.log('Custom query loaded successfully');
    } catch (error) {
      console.error(`Error reading query file: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  } else {
    console.log('Using default BCMR Chaingraph query...');
    query = DEFAULT_BCMR_QUERY;
  }

  const CHAINGRAPH_URL = process.env.CHAINGRAPH_URL || '';
  if (!CHAINGRAPH_URL) {
    console.error('Error: CHAINGRAPH_URL environment variable is not set');
    console.error('Please create a .env file with CHAINGRAPH_URL=<your-chaingraph-url>');
    process.exit(1);
  }

  console.log(`Querying Chaingraph at ${CHAINGRAPH_URL}...`);

  try {
    const response = await fetch(CHAINGRAPH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
      }),
    });

    if (!response.ok) {
      throw new Error(`Chaingraph request failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as {
      data?: { search_output_prefix?: any[] };
      errors?: Array<{ message: string }>;
    };

    if (data.errors) {
      throw new Error(`GraphQL errors: ${JSON.stringify(data.errors, null, 2)}`);
    }

    // Save raw result to file
    const jsonContent = JSON.stringify(data, null, 2);
    writeFileSync(chaingraphResultFile, jsonContent, 'utf-8');

    console.log(`\n✓ Chaingraph query successful`);
    console.log(`  Result saved to: ${chaingraphResultFile}`);

    // Show basic statistics if it's the standard query format
    if (data.data?.search_output_prefix) {
      const outputs = data.data.search_output_prefix;
      console.log(`  Found ${outputs.length} BCMR outputs`);
    }
  } catch (error) {
    console.error('Error querying Chaingraph:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

/**
 * Command: Resolve authchains and save to authhead.json
 * Now uses pre-loaded Chaingraph data from file instead of querying
 */
async function doAuthchainResolve(options: {
  authheadFile: string;
  jsonFolder: string;
  useCache: boolean;
  clearCache: boolean;
  verbose: boolean;
  concurrency: number;
  chaingraphResultFile: string;
}): Promise<void> {
  const { authheadFile, jsonFolder, useCache, clearCache, verbose, concurrency, chaingraphResultFile } = options;

  // Load Chaingraph data from file
  console.log(`Loading Chaingraph data from ${chaingraphResultFile}...`);

  if (!existsSync(chaingraphResultFile)) {
    console.error(`Error: Chaingraph result file not found: ${chaingraphResultFile}`);
    console.error('Please run --query-chaingraph first to generate the Chaingraph data file.');
    process.exit(1);
  }

  let chaingraphData: { data?: { search_output_prefix?: any[] } };
  try {
    const fileContent = readFileSync(chaingraphResultFile, 'utf-8');
    chaingraphData = JSON.parse(fileContent);

    if (!chaingraphData.data?.search_output_prefix) {
      console.error('Error: Invalid Chaingraph result file format. Expected data.search_output_prefix.');
      process.exit(1);
    }

    console.log(`Loaded ${chaingraphData.data.search_output_prefix.length} BCMR outputs from file`);
  } catch (error) {
    console.error(`Error reading Chaingraph result file: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }

  console.log('Resolving authchains...');
  const registries = await getBCMRRegistries({
    useCache,
    cachePath: join(jsonFolder, '.authchain-cache.json'),
    verbose,
    concurrency,
    chaingraphData,
  });

  console.log(`\nFound ${registries.length} total registries`);

  // Filter to current registries: both active (updatable) and burned (finalized)
  // Exclude superseded registries (replaced by newer authchain updates)
  const currentRegistries = registries.filter(
    (r) => r.isValid && (r.isBurned || r.isAuthheadUnspent)
  );

  // Calculate breakdown
  const activeCount = currentRegistries.filter(r => !r.isBurned && r.isAuthheadUnspent).length;
  const burnedCount = currentRegistries.filter(r => r.isBurned).length;
  const supersededCount = registries.filter(r => r.isValid && !r.isBurned && !r.isAuthheadUnspent).length;

  console.log(`\nFiltered to ${currentRegistries.length} current registries (active + burned):`);
  console.log(`  Active (updatable): ${activeCount}`);
  console.log(`  Burned (finalized): ${burnedCount}`);
  console.log(`  Excluded ${supersededCount} superseded registries`);

  // Convert to authhead.json format
  const authheadData: AuthheadRegistry[] = currentRegistries.map((r) => ({
    tokenId: r.tokenId,
    authbase: r.authbase,
    authhead: r.authhead,
    blockHeight: r.blockHeight,
    hash: r.hash,
    uris: r.uris,
    authchainLength: r.authchainLength,
    isActive: r.isAuthheadUnspent,
    isBurned: r.isBurned,
    isValid: r.isValid,
  }));

  // Save to authhead.json
  const jsonContent = JSON.stringify(authheadData, null, 2);
  writeFileSync(authheadFile, jsonContent, 'utf-8');

  console.log(`\n✓ Saved ${currentRegistries.length} current registries to ${authheadFile}`);
}

/**
 * Command: Export URLs from authhead.json
 */
async function doExport(options: {
  authheadFile: string;
  exportFile: string;
  protocols: string;
}): Promise<void> {
  const { authheadFile, exportFile, protocols } = options;

  // Load authhead.json
  console.log(`Reading ${authheadFile}...`);
  const registries = loadAuthheadFile(authheadFile);

  // Parse protocol filter
  const protocolsFilter = parseProtocolsFilter(protocols);

  // Extract and filter URLs
  const urls: string[] = [];
  for (const registry of registries) {
    for (const uri of registry.uris) {
      const protocol = classifyUrlProtocol(uri);

      // Check if protocol matches filter
      if (protocolsFilter.has('ALL') || protocolsFilter.has(protocol)) {
        urls.push(uri);
      }
    }
  }

  if (urls.length === 0) {
    console.log('No URLs found matching the specified protocols.');
    return;
  }

  // Count by protocol for statistics
  const ipfsCount = urls.filter((u) => classifyUrlProtocol(u) === 'IPFS').length;
  const httpsCount = urls.filter((u) => classifyUrlProtocol(u) === 'HTTPS').length;
  const otherCount = urls.filter((u) => classifyUrlProtocol(u) === 'OTHER').length;

  // Save to file (one URL per line)
  const txtOutput = urls.join('\n');
  writeFileSync(exportFile, txtOutput, 'utf-8');

  console.log(`\n✓ Exported ${urls.length} URLs to ${exportFile}`);
  console.log(`  IPFS: ${ipfsCount}, HTTPS: ${httpsCount}, OTHER: ${otherCount}`);
}

/**
 * Command: Export IPFS CIDs only from authhead.json
 */
async function doExportIPFSCIDs(options: {
  authheadFile: string;
  cidsFile: string;
}): Promise<void> {
  const { authheadFile, cidsFile } = options;

  // Load authhead.json
  console.log(`Reading ${authheadFile}...`);
  const registries = loadAuthheadFile(authheadFile);

  // Extract IPFS CIDs
  const cids: string[] = [];
  let ipfsUrlCount = 0;
  let gatewayUrlCount = 0;
  let skippedIpnsCount = 0;

  for (const registry of registries) {
    for (const uri of registry.uris) {
      const protocol = classifyUrlProtocol(uri);

      // Process IPFS URLs and HTTPS URLs (may contain gateway URLs)
      if (protocol === 'IPFS' || protocol === 'HTTPS') {
        // Extract CIDs from URL (handles ipfs://, gateway path-style, and subdomain-style)
        const extractedCids = extractCIDsFromURL(uri);

        if (extractedCids.length > 0) {
          // Track source type
          if (protocol === 'IPFS') {
            ipfsUrlCount++;
          } else {
            gatewayUrlCount++;
          }

          cids.push(...extractedCids);
        } else if (uri.includes('/ipns/') || uri.includes('.ipns.')) {
          // Track skipped IPNS URLs
          skippedIpnsCount++;
        }
      }
    }
  }

  if (cids.length === 0) {
    console.log('No valid IPFS CIDs found.');
    if (skippedIpnsCount > 0) {
      console.log(`  Skipped ${skippedIpnsCount} IPNS URLs (not CID-based)`);
    }
    return;
  }

  // Deduplicate CIDs
  const uniqueCids = Array.from(new Set(cids));

  // Sort alphabetically (case-sensitive)
  uniqueCids.sort();

  // Save to file (one CID per line)
  const txtOutput = uniqueCids.join('\n');
  writeFileSync(cidsFile, txtOutput, 'utf-8');

  console.log(`\n✓ Exported ${uniqueCids.length} unique IPFS CIDs to ${cidsFile}`);
  console.log(`  Total CIDs found: ${cids.length}`);
  console.log(`  Unique CIDs: ${uniqueCids.length}`);
  console.log(`  Duplicates removed: ${cids.length - uniqueCids.length}`);
  console.log(`  From ipfs:// URLs: ${ipfsUrlCount}`);
  console.log(`  From gateway URLs: ${gatewayUrlCount}`);
  if (skippedIpnsCount > 0) {
    console.log(`  Skipped IPNS URLs: ${skippedIpnsCount}`);
  }
}

/**
 * Recursively extract IPFS CIDs from a JSON structure
 * Traverses all strings, arrays, and objects looking for ipfs:// URIs and HTTPS gateway URLs
 * SECURITY: Includes depth limiting and circular reference detection
 */
function extractIPFSCIDsFromJSON(
  json: any,
  cids: Set<string>,
  depth: number = 0,
  visited: WeakSet<object> = new WeakSet()
): void {
  // Depth limit to prevent stack overflow
  if (depth > 100) {
    console.warn('Maximum recursion depth (100) reached, skipping deeper structures');
    return;
  }

  if (typeof json === 'string') {
    // Limit string length to prevent memory issues
    if (json.length > 10000) {
      return;
    }

    // Check if string contains IPFS CIDs (ipfs:// or HTTPS gateway URLs)
    if (json.startsWith('ipfs://') || json.startsWith('http://') || json.startsWith('https://')) {
      const extractedCids = extractCIDsFromURL(json);
      for (const cid of extractedCids) {
        cids.add(cid);
      }
    }
  } else if (Array.isArray(json)) {
    // Limit array size to prevent memory/CPU exhaustion
    if (json.length > 10000) {
      console.warn(`Array too large (${json.length} items), skipping`);
      return;
    }

    // Traverse array elements
    for (const item of json) {
      extractIPFSCIDsFromJSON(item, cids, depth + 1, visited);
    }
  } else if (typeof json === 'object' && json !== null) {
    // Prevent circular references
    if (visited.has(json)) {
      return;
    }
    visited.add(json);

    // Limit object size to prevent memory/CPU exhaustion
    const keys = Object.keys(json);
    if (keys.length > 10000) {
      console.warn(`Object too large (${keys.length} keys), skipping`);
      return;
    }

    // Traverse object properties
    for (const value of Object.values(json)) {
      extractIPFSCIDsFromJSON(value, cids, depth + 1, visited);
    }
  }
}

/**
 * Command: Extract IPFS CIDs from BCMR JSON files in a folder
 */
async function doExportCashtokenIPFSCIDs(options: {
  jsonFolder: string;
  cashtokenCidsFile: string;
  maxFileSizeMB: number;
}): Promise<void> {
  const { jsonFolder, cashtokenCidsFile, maxFileSizeMB } = options;

  // Check if folder exists
  if (!existsSync(jsonFolder)) {
    console.error(`Error: Folder not found: ${jsonFolder}`);
    console.error('Please run --fetch-json first to download BCMR JSON files.');
    process.exit(1);
  }

  console.log(`Reading BCMR JSON files from ${jsonFolder}...`);

  // Read all .json files from folder (excluding cache files)
  const files = readdirSync(jsonFolder).filter(
    (f) => f.endsWith('.json') && !f.startsWith('.')
  );

  if (files.length === 0) {
    console.log('No JSON files found in folder.');
    console.log('Please run --fetch-json first to download BCMR JSON files.');
    return;
  }

  console.log(`Found ${files.length} JSON files to process`);

  const allCids = new Set<string>();
  let processedCount = 0;
  let errorCount = 0;

  for (const file of files) {
    const filePath = join(jsonFolder, file);

    try {
      // Check file size before reading (security: prevent memory exhaustion)
      const stats = statSync(filePath);
      const maxFileSizeBytes = maxFileSizeMB * 1024 * 1024;
      if (stats.size > maxFileSizeBytes) {
        console.warn(`Warning: File ${file} too large (${(stats.size / 1024 / 1024).toFixed(2)}MB > ${maxFileSizeMB}MB), skipping`);
        errorCount++;
        continue;
      }

      const fileContent = readFileSync(filePath, 'utf-8');
      const json = sanitizeJSON(JSON.parse(fileContent));

      // Recursively extract IPFS CIDs from the JSON
      extractIPFSCIDsFromJSON(json, allCids);
      processedCount++;

      // Show progress every 500 files
      if (processedCount % 500 === 0) {
        console.log(`  Processed ${processedCount}/${files.length} files...`);
      }
    } catch (error) {
      errorCount++;
      console.warn(`Warning: Failed to process ${file}:`, error instanceof Error ? error.message : error);
    }
  }

  if (allCids.size === 0) {
    console.log('\nNo IPFS CIDs found in BCMR JSON files.');
    return;
  }

  // Convert to array, sort alphabetically
  const uniqueCids = Array.from(allCids).sort();

  // Save to file (one CID per line)
  const txtOutput = uniqueCids.join('\n');
  writeFileSync(cashtokenCidsFile, txtOutput, 'utf-8');

  console.log(`\n✓ Extracted ${uniqueCids.length} unique IPFS CIDs from BCMR JSON files`);
  console.log(`  Files processed: ${processedCount}`);
  console.log(`  Files with errors: ${errorCount}`);
  console.log(`  Output file: ${cashtokenCidsFile}`);
}

/**
 * Command: Pin IPFS CIDs using local IPFS daemon
 */
async function doIPFSPin(options: {
  cidsFile: string | null;
  verbose: boolean;
  concurrency: number;
  timeout: number;
}): Promise<void> {
  const { cidsFile, verbose, concurrency, timeout } = options;

  // Check if ipfs command exists
  console.log('Checking IPFS CLI availability...');
  try {
    execSync('which ipfs', { stdio: 'ignore' });
  } catch (error) {
    console.error('Error: ipfs command not found');
    console.error('Please install IPFS CLI:');
    console.error('  - https://docs.ipfs.tech/install/command-line/');
    console.error('  - Or run: brew install ipfs (macOS) or apt install ipfs (Linux)');
    process.exit(1);
  }

  // Check if IPFS daemon is running
  try {
    execSync('ipfs id', { stdio: 'ignore', timeout: 5000 });
  } catch (error) {
    console.error('Error: IPFS daemon not running');
    console.error('Please start IPFS daemon in another terminal:');
    console.error('  ipfs daemon');
    process.exit(1);
  }

  // Determine which files to pin
  const defaultFiles = [resolveWorkPath('bcmr-ipfs-cids.txt'), resolveWorkPath('cashtoken-ipfs-cids.txt')];
  const filesToPin = cidsFile ? [cidsFile] : defaultFiles;

  if (cidsFile === null) {
    console.log('Pinning from both default CID files...');
  }

  // Load pin cache
  const pinCacheFile = resolveWorkPath('./bcmr-registries/.ipfs-pin-cache.json');
  let pinnedCidsCache = new Set<string>();

  if (existsSync(pinCacheFile)) {
    try {
      const cacheContent = readFileSync(pinCacheFile, 'utf-8');
      const cacheData = JSON.parse(cacheContent);
      if (Array.isArray(cacheData.pinnedCids)) {
        pinnedCidsCache = new Set(cacheData.pinnedCids);
        console.log(`Loaded pin cache: ${pinnedCidsCache.size} previously pinned CIDs`);
      }
    } catch (error) {
      console.warn('Warning: Failed to load pin cache, will rebuild from scratch');
    }
  }

  // Track newly pinned CIDs across all files
  const newlyPinnedCids = new Set<string>();

  // Process each file
  for (const file of filesToPin) {
    // Check if CID file exists
    if (!existsSync(file)) {
      if (cidsFile) {
        // If user specified a file, it's an error
        console.error(`Error: ${file} not found.`);
        console.error('Please run one of these commands first:');
        console.error('  npm start -- --export-bcmr-ipfs-cids');
        console.error('  npm start -- --export-cashtoken-ipfs-cids');
        process.exit(1);
      } else {
        // If using defaults, just skip missing files
        console.log(`Skipping ${file} (not found)`);
        continue;
      }
    }

    // Read and parse CIDs from file
    console.log(`\nReading IPFS CIDs from ${file}...`);
    const fileContent = readFileSync(file, 'utf-8');
    const allCids = fileContent
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);

    if (allCids.length === 0) {
      console.log(`No CIDs found in ${file}.`);
      continue;
    }

    // Filter out already cached CIDs
    const cids = allCids.filter(cid => !pinnedCidsCache.has(cid));
    const cachedCount = allCids.length - cids.length;

    console.log(`Found ${allCids.length} CIDs in ${file}`);
    if (cachedCount > 0) {
      console.log(`  ${cachedCount} already pinned (cached), ${cids.length} to pin`);
    }

    if (cids.length === 0) {
      console.log('All CIDs already pinned (from cache), skipping IPFS operations...');
      // Show summary for fully-cached file
      console.log(`\n✓ IPFS pinning complete for ${file} (all from cache)`);
      console.log(`  Newly pinned: 0`);
      console.log(`  Already pinned: ${cachedCount} (${cachedCount} from cache)`);
      console.log(`  Failed: 0`);
      console.log(`  Total: ${allCids.length}`);
      continue;
    }

    // Pin CIDs with parallel processing
    let pinnedCount = 0;
    let alreadyPinnedCount = 0;
    let failedCount = 0;
    const startTime = Date.now();

    // Process CIDs in batches with concurrency control
    const processBatch = async (batch: string[]): Promise<void> => {
      const results = await Promise.all(
        batch.map(async (cid) => {
          try {
            return await new Promise<{ cid: string; success: boolean; alreadyPinned: boolean }>((resolve, reject) => {
              const controller = new AbortController();
              const proc = spawn('ipfs', ['pin', 'add', cid], {
                timeout: timeout * 1000,  // Convert seconds to milliseconds
                signal: controller.signal
              });

              let stdout = '';
              let stderr = '';

              proc.stdout.on('data', (data) => { stdout += data; });
              proc.stderr.on('data', (data) => { stderr += data; });

              proc.on('close', (code) => {
                if (code === 0 || stdout.includes('recursive')) {
                  // Check if already pinned
                  const alreadyPinned = stdout.includes('already') || stderr.includes('already');
                  resolve({ cid, success: true, alreadyPinned });
                } else {
                  reject(new Error(stderr.trim() || 'Unknown error'));
                }
              });

              proc.on('error', (err) => {
                if (err.name === 'AbortError') {
                  reject(new Error(`Timeout after ${timeout}s`));
                } else {
                  reject(err);
                }
              });
            });
          } catch (error) {
            return {
              cid,
              success: false,
              alreadyPinned: false,
              error: error instanceof Error ? error.message : String(error)
            };
          }
        })
      );

      // Update counters and log failures
      for (const result of results) {
        if (result.success) {
          // Add to cache for successfully pinned CIDs
          newlyPinnedCids.add(result.cid);

          if (result.alreadyPinned) {
            alreadyPinnedCount++;
            if (verbose) {
              console.log(`  ${result.cid.substring(0, 12)}... already pinned`);
            }
          } else {
            pinnedCount++;
            if (verbose) {
              console.log(`  ${result.cid.substring(0, 12)}... pinned`);
            }
          }
        } else {
          failedCount++;
          const errorMsg = 'error' in result ? result.error : 'Unknown error';
          console.warn(`Warning: Failed to pin ${result.cid.substring(0, 12)}...: ${errorMsg}`);
        }
      }
    };

    // Process CIDs in batches
    for (let i = 0; i < cids.length; i += concurrency) {
      const batch = cids.slice(i, Math.min(i + concurrency, cids.length));
      await processBatch(batch);

      // Progress reporting
      const processed = Math.min(i + concurrency, cids.length);
      if (processed % 50 === 0 || processed === cids.length) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const rate = ((processed / (Date.now() - startTime)) * 1000).toFixed(1);
        console.log(`  Pinning CIDs... ${processed}/${cids.length} (${elapsed}s, ${rate} CIDs/s)`);
      }
    }

    // Summary report for this file
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const totalAlreadyPinned = cachedCount + alreadyPinnedCount;

    console.log(`\n✓ IPFS pinning complete for ${file} in ${elapsed}s`);
    console.log(`  Newly pinned: ${pinnedCount}`);
    if (cachedCount > 0) {
      console.log(`  Already pinned: ${totalAlreadyPinned} (${cachedCount} from cache)`);
    } else {
      console.log(`  Already pinned: ${alreadyPinnedCount}`);
    }
    console.log(`  Failed: ${failedCount}`);
    console.log(`  Total: ${allCids.length}`);
  }

  // Save updated pin cache
  if (newlyPinnedCids.size > 0) {
    try {
      // Merge new pins with existing cache
      const allPinnedCids = new Set([...pinnedCidsCache, ...newlyPinnedCids]);
      const cacheData = {
        pinnedCids: Array.from(allPinnedCids).sort(),
        lastUpdated: new Date().toISOString(),
        totalCount: allPinnedCids.size,
      };

      // Ensure folder exists
      const cacheDir = pinCacheFile.substring(0, pinCacheFile.lastIndexOf('/'));
      if (!existsSync(cacheDir)) {
        mkdirSync(cacheDir, { recursive: true });
      }

      writeFileSync(pinCacheFile, JSON.stringify(cacheData, null, 2), 'utf-8');
      console.log(`\n✓ Saved pin cache: ${allPinnedCids.size} total pinned CIDs (${newlyPinnedCids.size} newly added)`);
    } catch (error) {
      console.warn('Warning: Failed to save pin cache:', error);
    }
  }
}

/**
 * Command: Fetch BCMR JSON files from authhead.json
 */
async function doFetchJson(options: {
  authheadFile: string;
  jsonFolder: string;
  validateSchema?: boolean;
  ignoreJsonHash?: boolean;
  concurrency?: number;
}): Promise<void> {
  const { authheadFile, jsonFolder, validateSchema = false, ignoreJsonHash = false, concurrency = 10 } = options;

  // Load authhead.json
  console.log(`Reading ${authheadFile}...`);
  const registries = loadAuthheadFile(authheadFile);

  // Create JSON folder if needed
  try {
    mkdirSync(jsonFolder, { recursive: true });
  } catch (error) {
    console.error(`Failed to create folder ${jsonFolder}:`, error);
    throw error;
  }

  // Load validation cache if schema validation is enabled
  let validationCache: any = null;
  const validationCachePath = join(jsonFolder, '.validation-cache.json');

  if (validateSchema) {
    const { loadValidationCache, createEmptyCache, getCacheStats } = await import('./lib/validation-cache.js');
    validationCache = loadValidationCache(validationCachePath);
    const stats = getCacheStats(validationCache);

    if (stats.totalEntries > 0) {
      console.log(`Loaded validation cache: ${stats.invalidEntries} known-invalid entries`);
    }
  }

  console.log(`\nFetching BCMR JSON files${validateSchema ? ' with schema validation' : ''}...`);
  if (concurrency > 1) {
    console.log(`Using parallel processing (concurrency: ${concurrency})`);
  }

  let fetchedCount = 0;
  let validCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  let schemaInvalidCount = 0;
  let processedCount = 0;
  const startTime = Date.now();

  /**
   * Process a single registry
   */
  const processRegistry = async (registry: AuthheadRegistry): Promise<{
    success: boolean;
    fetched: boolean;
    skipped: boolean;
    schemaInvalid: boolean;
  }> => {
    // SECURITY: Sanitize tokenId to prevent path traversal attacks
    let safeTokenId: string;
    try {
      safeTokenId = sanitizeTokenId(registry.tokenId);
    } catch (error) {
      console.warn(`Skipping registry with invalid tokenId format: ${error instanceof Error ? error.message : error}`);
      return { success: false, fetched: false, skipped: false, schemaInvalid: false };
    }

    const jsonPath = join(jsonFolder, `${safeTokenId}.json`);
    let registryJson = null;

    // Check if file already exists locally
    if (existsSync(jsonPath)) {
      try {
        const fileContent = readFileSync(jsonPath, 'utf-8');
        const computedHash = createHash('sha256').update(fileContent).digest('hex');

        if (computedHash === registry.hash) {
          // Hash matches, use existing file (skip network fetch)
          registryJson = sanitizeJSON(JSON.parse(fileContent));
          return { success: true, fetched: false, skipped: true, schemaInvalid: false };
        } else {
          // Hash mismatch, file is outdated or corrupted
          console.warn(`Hash mismatch for ${safeTokenId}, refetching...`);
        }
      } catch (error) {
        // File exists but can't read/parse, will fetch from network
        console.warn(`Error reading local file for ${safeTokenId}, refetching...`);
      }
    }

    // If not found locally or hash mismatch, fetch from network
    if (!registryJson) {
      try {
        // Get validation cache entry for this hash (if schema validation enabled)
        // NOTE: We look up by claimed hash from OP_RETURN. If content with this hash
        // was previously validated, it will be in the cache (since actual == claimed when verified)
        const validationCacheEntry = validateSchema && validationCache
          ? validationCache.entries[registry.hash]
          : null;

        const fetchResult = await fetchAndValidateRegistry(
          registry.uris,
          registry.hash,
          2, // maxRetries
          2000, // timeoutMs
          validateSchema,
          validationCacheEntry,
          ignoreJsonHash
        );

        if (fetchResult.success) {
          // Save the raw JSON content (preserves exact formatting and hash)
          writeFileSync(jsonPath, fetchResult.rawContent, 'utf-8');
          registryJson = fetchResult.json;

          // Update validation cache if schema validation was performed
          // Cache using the ACTUAL hash of the content (not the claimed hash from OP_RETURN)
          if (validateSchema && validationCache) {
            validationCache.entries[fetchResult.computedHash] = {
              hash: fetchResult.computedHash,
              url: registry.uris[0] || 'unknown',
              isValid: true,
              lastChecked: Date.now(),
              attemptCount: (validationCacheEntry?.attemptCount || 0) + 1,
            };
          }

          return { success: true, fetched: true, skipped: false, schemaInvalid: false };
        } else if (fetchResult.schemaInvalid) {
          // Schema validation failed - cache the ACTUAL hash as invalid
          // This ensures we don't re-download content we know is invalid
          if (validateSchema && validationCache) {
            validationCache.entries[fetchResult.computedHash] = {
              hash: fetchResult.computedHash,
              url: registry.uris[0] || 'unknown',
              isValid: false,
              validationErrors: fetchResult.validationErrors,
              lastChecked: Date.now(),
              attemptCount: (validationCacheEntry?.attemptCount || 0) + 1,
            };
          }

          return { success: false, fetched: false, skipped: false, schemaInvalid: true };
        } else {
          // Other failure (network error, hash mismatch, parse error, etc.)
          // DO NOT cache these - they might be transient errors
          return { success: false, fetched: false, skipped: false, schemaInvalid: false };
        }
      } catch (error) {
        return { success: false, fetched: false, skipped: false, schemaInvalid: false };
      }
    } else {
      return { success: true, fetched: false, skipped: false, schemaInvalid: false };
    }
  };

  /**
   * Process registries in batches with concurrency control
   */
  const processBatch = async (batch: AuthheadRegistry[], batchStartIndex: number): Promise<void> => {
    const results = await Promise.all(batch.map(registry => processRegistry(registry)));

    // Update counters
    for (const result of results) {
      if (result.success) {
        validCount++;
        if (result.fetched) fetchedCount++;
        if (result.skipped) skippedCount++;
      } else {
        failedCount++;
        if (result.schemaInvalid) schemaInvalidCount++;
      }
      processedCount++;
    }

    // Progress reporting
    if (processedCount % 50 === 0 || processedCount === registries.length) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const rate = ((processedCount / (Date.now() - startTime)) * 1000).toFixed(1);
      console.log(`  Processing... ${processedCount}/${registries.length} (${elapsed}s, ${rate} reg/s)`);
    }
  };

  // Process in batches
  for (let i = 0; i < registries.length; i += concurrency) {
    const batch = registries.slice(i, i + concurrency);
    await processBatch(batch, i);
  }

  // Save validation cache if schema validation was enabled
  if (validateSchema && validationCache) {
    const { saveValidationCache } = await import('./lib/validation-cache.js');
    saveValidationCache(validationCache, validationCachePath);
    console.log(`\nValidation cache saved to ${validationCachePath}`);
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`\n✓ BCMR JSON summary (${totalTime}s):`);
  console.log(`  Fetched from network: ${fetchedCount}`);
  console.log(`  Used local cache: ${skippedCount}`);
  console.log(`  Total valid: ${validCount}`);
  console.log(`  Failed: ${failedCount}`);
  if (validateSchema && schemaInvalidCount > 0) {
    console.log(`  Schema validation failures: ${schemaInvalidCount}`);
  }
  console.log(`  Saved to: ${jsonFolder}/`);
}

/**
 * Main function
 */
async function main(): Promise<void> {
  try {
    const args = parseArgs();

    // Show version if requested
    if (args.showVersion) {
      console.log(`bch-ipfs-scrape v${VERSION}`);
      process.exit(0);
    }

    // Show help if requested or no commands specified
    if (args.showHelp || (!args.queryChaingraph && !args.authchainResolve && !args.export && !args.exportBcmrIpfsCids && !args.exportCashtokenIpfsCids && !args.fetchJson && !args.fetchValidJson && !args.ipfsPin)) {
      printUsage();
      process.exit(0);
    }

    // Create work directory if BCMR_WORKDIR is specified
    const workDir = getWorkDir();
    if (workDir) {
      try {
        mkdirSync(workDir, { recursive: true });
        console.log(`Using work directory: ${workDir}`);
      } catch (error) {
        console.error(`Error: Failed to create work directory: ${workDir}`);
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
      }
    }

    // Check for required environment variables (only for commands that need them)
    if (args.queryChaingraph) {
      if (!process.env.CHAINGRAPH_URL) {
        console.error('Error: CHAINGRAPH_URL environment variable is not set');
        console.error('Please create a .env file with CHAINGRAPH_URL=<your-chaingraph-url>');
        process.exit(1);
      }
    }

    if (args.authchainResolve) {
      if (!process.env.FULCRUM_WS_URL) {
        console.error('Error: FULCRUM_WS_URL environment variable is not set');
        console.error('Please add FULCRUM_WS_URL=<your-fulcrum-ws-url> to .env file');
        process.exit(1);
      }
    }

    // Handle cache clearing (only for authchain-resolve)
    if (args.clearCache && args.authchainResolve) {
      const cachePath = join(args.jsonFolder, '.authchain-cache.json');
      try {
        if (existsSync(cachePath)) {
          unlinkSync(cachePath);
          console.log('Authchain cache cleared');
        } else {
          console.log('No cache file to clear');
        }
      } catch (error) {
        console.warn(`Failed to clear cache: ${error instanceof Error ? error.message : error}`);
      }
    }

    // Execute commands in order: query -> resolve -> fetch -> export -> pin
    if (args.queryChaingraph) {
      await doQueryChaingraph({
        chaingraphQueryFile: args.chaingraphQueryFile,
        chaingraphResultFile: args.chaingraphResultFile,
      });
    }

    if (args.authchainResolve) {
      await doAuthchainResolve({
        authheadFile: args.authheadFile,
        jsonFolder: args.jsonFolder,
        useCache: args.useCache,
        clearCache: args.clearCache,
        verbose: args.verbose,
        concurrency: args.concurrency,
        chaingraphResultFile: args.chaingraphResultFile,
      });
    }

    if (args.fetchJson || args.fetchValidJson) {
      await doFetchJson({
        authheadFile: args.authheadFile,
        jsonFolder: args.jsonFolder,
        validateSchema: args.fetchValidJson,
        ignoreJsonHash: args.ignoreJsonHash,
        concurrency: args.jsonConcurrency,
      });
    }

    if (args.export) {
      await doExport({
        authheadFile: args.authheadFile,
        exportFile: args.exportFile,
        protocols: args.export,
      });
    }

    if (args.exportBcmrIpfsCids) {
      await doExportIPFSCIDs({
        authheadFile: args.authheadFile,
        cidsFile: args.cidsFile,
      });
    }

    if (args.exportCashtokenIpfsCids) {
      await doExportCashtokenIPFSCIDs({
        jsonFolder: args.jsonFolder,
        cashtokenCidsFile: args.cashtokenCidsFile,
        maxFileSizeMB: args.maxFileSizeMB,
      });
    }

    if (args.ipfsPin) {
      await doIPFSPin({
        cidsFile: args.ipfsPinCidsFile,
        verbose: args.verbose,
        concurrency: args.ipfsPinConcurrency,
        timeout: args.ipfsPinTimeout,
      });
    }

    // Clean up: close WebSocket connection pool
    await closeConnectionPool();
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);

    // Clean up: close WebSocket connection pool
    await closeConnectionPool();

    process.exit(1);
  }
}

// Run the main function
main();
