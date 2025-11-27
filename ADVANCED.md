# Advanced Usage

This document provides detailed technical information about the BCMR Registry Tool.

## Table of Contents

- [Project Structure](#project-structure)
- [Two-Step Workflow](#two-step-workflow)
- [Authchain Caching](#authchain-caching)
- [IPFS Pin Caching](#ipfs-pin-caching)
- [Command Reference](#command-reference)
- [Output Formats](#output-formats)
- [Filtering Rules](#filtering-rules)
- [Cache Behavior](#cache-behavior)
- [Development](#development)

## Project Structure

```text
/
├── src/
│   ├── index.ts                  # Main console app entry point
│   └── lib/
│       ├── bcmr.ts               # BCMR parsing, authchain resolution, JSON validation
│       ├── fulcrum-client.ts     # Fulcrum Electrum protocol client
│       └── authchain-cache.ts    # Authchain caching logic
├── bcmr-registries/
│   ├── .authchain-cache.json     # Authchain resolution cache (auto-generated)
│   ├── .ipfs-pin-cache.json      # IPFS pin cache (auto-generated)
│   └── *.json                    # Registry JSON files (with --fetch-json)
├── chaingraph-result.json        # Raw Chaingraph query results (with --query-chaingraph)
├── authhead.json                 # Current registries: active + burned (with --authchain-resolve)
├── exported-urls.txt             # Exported URLs (with --export)
├── bcmr-ipfs-cids.txt            # Exported IPFS CIDs (with --export-bcmr-ipfs-cids)
├── cashtoken-ipfs-cids.txt       # Exported CashToken IPFS CIDs (with --export-cashtoken-ipfs-cids)
├── pin-cids.sh                   # Bash script for sequential IPFS pinning
├── .env                          # Environment configuration
├── package.json                  # Project dependencies and scripts
└── tsconfig.json                 # TypeScript configuration
```

## Two-Step Workflow

Starting with version 1.0.0, the tool separates Chaingraph querying from authchain resolution into two distinct steps:

### Step 1: Query Chaingraph (`--query-chaingraph`)

Queries Chaingraph and saves raw results to a file (default: `chaingraph-result.json`).

**Benefits:**
- **Custom queries** - Provide your own GraphQL query file to influence input data
- **Inspection** - Review Chaingraph results before processing
- **Iteration** - Re-run authchain resolution without re-querying Chaingraph
- **Reduced load** - Avoid redundant Chaingraph queries during development

**Usage:**
```bash
# Default BCMR query
bch-ipfs-scrape --query-chaingraph

# Custom GraphQL query
bch-ipfs-scrape --query-chaingraph my-custom-query.graphql

# Custom output file location
bch-ipfs-scrape --query-chaingraph --chaingraph-result-file ./data/results.json
```

### Step 2: Resolve Authchains (`--authchain-resolve`)

Loads Chaingraph data from the result file and resolves authchains to determine current registry states.

**Requirements:**
- Must run `--query-chaingraph` first (or have an existing `chaingraph-result.json`)
- Requires `FULCRUM_WS_URL` in `.env` (does not need `CHAINGRAPH_URL`)

**Usage:**
```bash
# Basic usage (uses ./chaingraph-result.json)
bch-ipfs-scrape --authchain-resolve

# Custom result file location
bch-ipfs-scrape --authchain-resolve --chaingraph-result-file ./data/results.json
```

### Combined Workflow

You can combine both commands in a single invocation:

```bash
# Query and resolve in one command
bch-ipfs-scrape --query-chaingraph --authchain-resolve --fetch-json --export-bcmr-ipfs-cids --ipfs-pin
```

## Authchain Caching

### How It Works

The tool automatically caches authchain resolution results to avoid redundant blockchain queries on subsequent runs.

**Cache Location:** `bcmr-registries/.authchain-cache.json`

**Cache Types:**

1. **Perfect hits** - Inactive chains (authhead spent, chain ended)
   - Never need revalidation
   - Zero blockchain queries required

2. **Good hits** - Active chains (authhead still unspent)
   - Requires one query to verify authhead is still unspent
   - No authchain walk needed if still valid

3. **Partial hits** - Active chains where authhead was spent
   - Continues from cached chain
   - Only queries new transactions since last run

4. **Misses** - New registries not in cache
   - Full authchain walk required

### Cache Management

**Enable/Disable:**
```bash
# Use cache (default, requires --query-chaingraph first)
bch-ipfs-scrape --query-chaingraph --authchain-resolve

# Disable cache (force full resolution)
bch-ipfs-scrape --query-chaingraph --authchain-resolve --no-cache

# Clear cache and start fresh
bch-ipfs-scrape --query-chaingraph --authchain-resolve --clear-cache
```

**Cache Updates:**
- Cache is saved only on successful completion
- Interrupted runs do not corrupt the cache
- Atomic write ensures data integrity

### Cache Statistics

Run with `--verbose` to see detailed cache information:

```bash
bch-ipfs-scrape --query-chaingraph --authchain-resolve --verbose
```

Example output:
```
Loaded authchain cache from ./bcmr-registries/.authchain-cache.json
  3124 entries (1543 active, 1581 inactive)
  Cache age: oldest 2.3h, newest 0.1h

Cache Performance:
  Perfect hits: 1581 (0 queries each)
  Good hits: 1512 (1 query each)
  Partial hits: 28 (continued from cache)
  Misses: 3 (full authchain walk)
  Total: 3121/3124 cached (99.9%)

Fulcrum Query Statistics:
  Total queries: 1587
  Average per registry: 0.51
```

## IPFS Pin Caching

### How It Works

The tool automatically caches successfully pinned CIDs to avoid redundant pinning operations on subsequent runs.

**Cache Location:** `bcmr-registries/.ipfs-pin-cache.json`

**Benefits:**
- **Skip already-pinned CIDs** - Dramatically speeds up subsequent pin operations
- **Automatic cache management** - No manual intervention required
- **Persistent across runs** - Cache survives restarts and updates

### Cache Behavior

**On Each Run:**
1. Loads existing cache (if present)
2. Filters out already-cached CIDs before processing
3. Pins only new CIDs
4. Updates cache with newly pinned CIDs
5. Saves merged cache to disk

**Cache Updates:**
- Only successfully pinned CIDs are cached
- Failed pins are NOT cached (will retry on next run)
- Cache is saved after all files are processed
- Atomic write ensures data integrity

### Cache File Format

JSON file containing:
```json
{
  "pinnedCids": [
    "QmVwdDCY4SPGVFnNCiZnX5CtzwWDn6kAM98JXzKxE3kCmn",
    "bafyreihwqw6lsve7gkorqemerjrl3t5fjxpjdljbndto467zixmstw43aq",
    ...
  ],
  "lastUpdated": "2025-01-15T12:34:56.789Z",
  "totalCount": 1234
}
```

**Fields:**
- `pinnedCids` - Array of successfully pinned CID strings (sorted)
- `lastUpdated` - ISO 8601 timestamp of last cache update
- `totalCount` - Total number of cached CIDs

### Manual Cache Management

The pin cache is managed automatically, but you can manually manage it if needed:

**View cache:**
```bash
cat bcmr-registries/.ipfs-pin-cache.json | jq '.totalCount'
```

**Clear cache:**
```bash
rm bcmr-registries/.ipfs-pin-cache.json
```

**Note:** Unlike authchain cache, there's no `--clear-pin-cache` flag. Simply delete the file to rebuild the cache from scratch.

## Command Reference

### Full Command List

| Command | Description | Default | Options |
|---------|-------------|---------|---------|
| `--query-chaingraph [file]` | Query Chaingraph and save raw results (required first step). Optional: provide custom GraphQL query file | - | `--chaingraph-result-file` |
| `--authchain-resolve` | Resolve authchains from Chaingraph result file and save to authhead.json (requires --query-chaingraph first) | - | `--verbose`, `--concurrency`, `--no-cache`, `--clear-cache`, `--authhead-file`, `--json-folder`, `--chaingraph-result-file` |
| `--export <protocols>` | Export URLs from authhead.json | - | `--authhead-file`, `--export-file` |
| `--export-bcmr-ipfs-cids` | Export IPFS CIDs from authhead.json | - | `--authhead-file`, `--cids-file` |
| `--export-cashtoken-ipfs-cids` | Extract IPFS CIDs from BCMR JSON files | - | `--json-folder`, `--cashtoken-cids-file`, `--max-file-size-mb` |
| `--fetch-json` | Fetch BCMR JSON files | - | `--authhead-file`, `--json-folder` |
| `--ipfs-pin` | Pin IPFS CIDs from both default files using local IPFS daemon (uses cache to skip already-pinned CIDs) | - | `--ipfs-pin-file`, `--ipfs-pin-timeout`, `--ipfs-pin-concurrency`, `--verbose` |

### Options Reference

| Option | Description | Default | Range/Values |
|--------|-------------|---------|--------------|
| `--chaingraph-result-file <path>` | Path to save/load Chaingraph results | `./chaingraph-result.json` | Any valid path |
| `--authhead-file <path>` | Path to authhead.json | `./authhead.json` | Any valid path |
| `--export-file <filename>` | Export output filename | `exported-urls.txt` | Any filename |
| `--cids-file <filename>` | BCMR CIDs output filename | `bcmr-ipfs-cids.txt` | Any filename |
| `--cashtoken-cids-file <file>` | CashToken CIDs output filename | `cashtoken-ipfs-cids.txt` | Any filename |
| `--ipfs-pin-file <filename>` | CIDs file to pin | Both `bcmr-ipfs-cids.txt` and `cashtoken-ipfs-cids.txt` | Any filename |
| `--ipfs-pin-timeout <seconds>` | Timeout per CID in seconds | `5` | 1-600 |
| `--ipfs-pin-concurrency <num>` | Parallel pin concurrency | `5` | 1-200 |
| `--json-folder <path>` | Folder for cache and BCMR JSON | `./bcmr-registries` | Any directory |
| `--max-file-size-mb <num>` | Max JSON file size in MB | `50` | 1-1000 |
| `--no-cache` | Disable authchain caching | false | Flag (no value) |
| `--clear-cache` | Delete cache before running | false | Flag (no value) |
| `--concurrency, -c <num>` | Parallel query concurrency | `50` | 1-200 |
| `--verbose, -v` | Enable verbose logging | false | Flag (no value) |
| `--help, -h` | Show help message | - | Flag (no value) |

### Protocol Filters

| Filter | Includes |
|--------|----------|
| `IPFS` | `ipfs://` URIs |
| `HTTPS` | `http://` and `https://` URIs |
| `OTHER` | All other protocols (`dweb://`, etc.) |
| `ALL` | All URIs regardless of protocol |

Multiple protocols can be combined with commas: `--export IPFS,HTTPS`

## Output Formats

### authhead.json

Array of active registry objects:

```json
[
  {
    "tokenId": "abc123...",
    "authbase": "abc123...",
    "authhead": "def456...",
    "blockHeight": 850000,
    "hash": "sha256hash...",
    "uris": [
      "ipfs://Qm...",
      "https://example.com/bcmr.json"
    ],
    "authchainLength": 2,
    "isActive": true,
    "isBurned": false,
    "isValid": true
  }
]
```

**Fields:**
- `tokenId` - Token/registry identifier (transaction hash)
- `authbase` - First transaction in authchain
- `authhead` - Current (latest) transaction in authchain
- `blockHeight` - Block height of authbase transaction
- `hash` - SHA-256 hash of registry content
- `uris` - Array of registry URIs
- `authchainLength` - Number of transactions in chain
- `isActive` - Whether authhead is unspent
- `isBurned` - Whether registry was burned
- `isValid` - Whether registry has valid URIs

### exported-urls.txt

Plain text with one URL per line:

```
ipfs://QmHash1...
ipfs://QmHash2...
https://example.com/registry.json
```

### bcmr-ipfs-cids.txt

Plain text with one CID per line (deduplicated and sorted):

```
QmVwdDCY4SPGVFnNCiZnX5CtzwWDn6kAM98JXzKxE3kCmn
bafyreihwqw6lsve7gkorqemerjrl3t5fjxpjdljbndto467zixmstw43aq
zb2rhY3zDDA4RYEHbkwLjVB8v84u7x4Ztda8oVpyVGnQV
```

**Processing:**
- Extracts CIDs from `ipfs://` URLs
- Removes path components (e.g., `ipfs://Qm.../path/file` → `Qm...`)
- Deduplicates automatically
- Sorts alphabetically
- Invalid CIDs skipped with warning

### cashtoken-ipfs-cids.txt

Same format as bcmr-ipfs-cids.txt, but extracted from BCMR JSON files instead of authhead.json.

### BCMR JSON Files

Registry JSON files saved in `--json-folder`, named by token ID:

```
bcmr-registries/
├── abc123def456.json
├── 789ghi012jkl.json
└── ...
```

Each file contains the validated BCMR registry data with hash verification.

## Filtering Rules

### Current Registry Criteria

`authhead.json` contains only current registries (excludes superseded ones):

**Included:**
- ✅ Valid (`isValid === true`, has URIs and proper format)
- ✅ Either active OR burned:
  - **Active** (`!isBurned && isAuthheadUnspent`): Can still be updated via authchain
  - **Burned** (`isBurned`): Finalized/immutable, cannot be updated

**Excluded:**
- ❌ **Superseded** (`!isBurned && !isAuthheadUnspent`): Replaced by newer authchain update
- ❌ **Invalid** (`!isValid`): Malformed or no URIs

### URL Protocol Filtering

Protocol filters (`--export`) determine which URIs are exported:

- `IPFS` - Matches `ipfs://` prefix
- `HTTPS` - Matches `http://` or `https://` prefix
- `OTHER` - Matches any other protocol
- `ALL` - No filtering, exports all URIs

## Cache Behavior

### When Cache Is Used

- **--authchain-resolve** - Always attempts to use cache unless `--no-cache` specified
- Cache location: `bcmr-registries/.authchain-cache.json`
- Created automatically on first run

### Cache Invalidation

Cache entries are revalidated when:
- Active chains: Checked if authhead is still unspent
- Spent authheads: Chain is extended from cached position
- Never revalidated: Inactive chains (authhead already spent)

### Cache Safety

- **Atomic writes** - Cache saved in single operation
- **Interruption safe** - Incomplete runs don't corrupt cache
- **Manual clearing** - Use `--clear-cache` to delete
- **Disable temporarily** - Use `--no-cache` to bypass

### Cache File Format

JSON file containing:
```json
{
  "tokenId": {
    "tokenId": "string",
    "authbase": "string",
    "authhead": "string",
    "authchainLength": number,
    "isActive": boolean,
    "timestamp": "ISO 8601 string"
  }
}
```

## Development

### Build Standalone Binary

```bash
# Build binary for testing (x64 only)
npm run pkg:test
./test-binary --help

# Build binaries for distribution (x64 and arm64)
npm run pkg
./bin/bch-ipfs-scrape-linux-x64 --help
./bin/bch-ipfs-scrape-linux-arm64 --help
```

### Development Mode (with Node.js)

Run with automatic rebuild on changes:

```bash
npm run dev
```

### Build Only (TypeScript)

```bash
npm run build
```

### Source Code Organization

- `src/index.ts` - CLI interface, command parsing, main application flow
- `src/lib/bcmr.ts` - BCMR parsing, authchain resolution, validation logic
- `src/lib/fulcrum-client.ts` - WebSocket connection pool, Fulcrum protocol client
- `src/lib/authchain-cache.ts` - Cache loading, saving, hit/miss logic

### Adding New Commands

1. Add command flag in `parseArgs()` return type and parsing logic
2. Create command function (e.g., `doMyCommand()`)
3. Add command execution in `main()` function
4. Update help text in `printUsage()`
5. Update README.md with usage examples

### Testing

The tool can be tested with different data sources:

```bash
# Test with custom Chaingraph endpoint
CHAINGRAPH_URL=http://test-server:8088/v1/graphql bch-ipfs-scrape --query-chaingraph --authchain-resolve

# Test with custom GraphQL query
bch-ipfs-scrape --query-chaingraph custom-query.graphql --authchain-resolve

# Test with different concurrency levels
bch-ipfs-scrape --query-chaingraph --authchain-resolve --concurrency 10 --verbose

# Test cache behavior
bch-ipfs-scrape --query-chaingraph --authchain-resolve --clear-cache --verbose
bch-ipfs-scrape --authchain-resolve --verbose  # Should show cache hits (reuses chaingraph-result.json)
```

## Troubleshooting

### Common Issues

**"CHAINGRAPH_URL environment variable is not set"**
- Copy `.env.example` to `.env`
- Set both `CHAINGRAPH_URL` and `FULCRUM_WS_URL`

**"IPFS daemon not running"**
- Start IPFS daemon: `ipfs daemon`
- Or use bash script which provides better error messages

**Cache corruption**
- Clear cache: `bch-ipfs-scrape --authchain-resolve --clear-cache`
- Delete manually: `rm bcmr-registries/.authchain-cache.json`

**Timeout errors during IPFS pinning**
- Increase timeout: `--ipfs-pin-timeout 30`
- Use lower concurrency: `--concurrency 10`
- Check IPFS daemon connectivity

**Connection pool errors**
- Reduce concurrency: `--concurrency 20`
- Check Fulcrum server is accessible
- Verify WebSocket URL in `.env`

### Verbose Output

Use `--verbose` flag for detailed diagnostic information:

```bash
bch-ipfs-scrape --query-chaingraph --authchain-resolve --verbose
bch-ipfs-scrape --ipfs-pin --verbose
```

This shows:
- Per-registry processing details
- Cache hit/miss information
- Query counts and timing
- Error details
