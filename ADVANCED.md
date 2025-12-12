# Advanced Usage

This document provides detailed technical information about the BCMR Registry Tool.

## Table of Contents

- [Project Structure](#project-structure)
- [Working with Chaingraph Data](#working-with-chaingraph-data)
- [Caching](#caching)
- [IPFS Gateway Rewriting](#ipfs-gateway-rewriting)
- [Command Reference](#command-reference)
- [Output Formats](#output-formats)
- [Filtering Rules](#filtering-rules)
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
│   ├── .validation-cache.json    # Validation cache (auto-generated)
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

## Working with Chaingraph Data

The tool provides flexible options for working with Chaingraph data, allowing you to customize queries, inspect results, or reuse existing data.

### Querying Chaingraph (`--query-chaingraph`)

Fetches BCMR registry data from Chaingraph and saves it locally.

**Basic usage:**
```bash
# Use default BCMR query
bch-ipfs-scrape --query-chaingraph --authchain-resolve
```

**Advanced options:**

**Custom GraphQL queries:**
```bash
# Provide your own GraphQL query file
bch-ipfs-scrape --query-chaingraph my-custom-query.graphql --authchain-resolve
```

**Custom storage location:**
```bash
# Save results to specific location
bch-ipfs-scrape --query-chaingraph --chaingraph-result-file ./data/results.json
```

**Why use custom queries?**
- Filter specific registries or token categories
- Adjust query parameters for different block ranges
- Experiment with alternative data sources

### Reusing Chaingraph Results

Chaingraph results are saved to disk (default: `chaingraph-result.json`). You can reprocess the same data without re-querying Chaingraph:

```bash
# Initial query
bch-ipfs-scrape --query-chaingraph --authchain-resolve

# Later: reprocess the same data with different options
bch-ipfs-scrape --authchain-resolve --fetch-json
bch-ipfs-scrape --authchain-resolve --no-cache --verbose
```

**Benefits:**
- **Faster iteration** - Skip network queries during testing or development
- **Inspect data** - Review `chaingraph-result.json` before processing
- **Reduced load** - Avoid redundant Chaingraph queries
- **Offline processing** - Work with cached data without Chaingraph access

**Requirements:**
- Authchain resolution requires `FULCRUM_WS_URL` in `.env`
- Querying Chaingraph requires `CHAINGRAPH_URL` in `.env`
- Reusing results only requires `FULCRUM_WS_URL`

### Complete Workflow Examples

**Standard workflow (query + process):**
```bash
bch-ipfs-scrape --query-chaingraph --authchain-resolve --fetch-json --ipfs-pin
```

**Separate query and processing:**
```bash
# First: query and inspect
bch-ipfs-scrape --query-chaingraph
cat chaingraph-result.json | jq '.data | length'

# Later: process with specific options
bch-ipfs-scrape --authchain-resolve --fetch-valid-json --export-bcmr-ipfs-cids
```

**Custom query with custom storage:**
```bash
bch-ipfs-scrape \
  --query-chaingraph custom-query.graphql \
  --chaingraph-result-file ./data/my-registries.json \
  --authchain-resolve \
  --fetch-json
```

## Caching

### Overview

The tool implements multiple caching layers to avoid redundant operations:

| Cache Type | What It Stores | Storage Location | Scope |
|------------|----------------|------------------|-------|
| Authchain Cache | Authchain resolution results | `.authchain-cache.json` | Persistent |
| IPFS Pin Cache | Successfully pinned CIDs | `.ipfs-pin-cache.json` | Persistent |
| Validation Cache | Invalid JSON files | `.validation-cache.json` | Persistent |
| JSON File Cache | Downloaded registry files | `{tokenId}.json` files | Persistent |

All persistent caches are stored in the output directory (default: `./bcmr-registries/`).

Use `--no-cache` to bypass caching behavior.

### Authchain Cache

**Purpose:** Avoids redundant blockchain queries by caching authchain resolution results.

**Storage Location:** `bcmr-registries/.authchain-cache.json`

**How It Works:**

The cache stores the result of walking each authchain (following the chain of OP_RETURN outputs from authbase to authhead). On subsequent runs:

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

**What Gets Cached:**

Each cache entry stores:
- Authbase transaction ID
- Current authhead transaction ID
- Chain length (number of hops)
- Active status (whether authhead output is unspent)
- Last checked timestamp

**Cache Updates:**
- Cache is saved only on successful completion
- Interrupted runs do not corrupt the cache
- Atomic write ensures data integrity

**Verbose Output:**

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

### IPFS Pin Cache

**Purpose:** Avoids redundant IPFS pinning operations by tracking successfully pinned CIDs.

**Storage Location:** `bcmr-registries/.ipfs-pin-cache.json`

**How It Works:**

On each run with `--ipfs-pin`:
1. Loads existing cache (if present)
2. Filters out already-cached CIDs before processing
3. Pins only new CIDs
4. Updates cache with newly pinned CIDs
5. Saves merged cache to disk

**What Gets Cached:**

Only successfully pinned CIDs are cached. Failed pins are NOT cached and will retry on the next run.

**Cache Structure:**

JSON file containing:
```json
{
  "pinnedCids": [
    "QmVwdDCY4SPGVFnNCiZnX5CtzwWDn6kAM98JXzKxE3kCmn",
    "bafyreihwqw6lsve7gkorqemerjrl3t5fjxpjdljbndto467zixmstw43aq"
  ],
  "lastUpdated": "2025-01-15T12:34:56.789Z",
  "totalCount": 1234
}
```

**Fields:**
- `pinnedCids` - Array of successfully pinned CID strings (sorted)
- `lastUpdated` - ISO 8601 timestamp of last cache update
- `totalCount` - Total number of cached CIDs

**Cache Updates:**
- Cache is saved after all files are processed
- Atomic write ensures data integrity

### Validation Cache

**Purpose:** Prevents re-downloading and re-validating files known to be schema-invalid.

**Storage Location:** `bcmr-registries/.validation-cache.json`

**How It Works:**

Active only when using `--fetch-valid-json` (not plain `--fetch-json`):
- Before downloading: checks if the hash is cached as invalid → skips download
- After validation fails: caches the actual content hash with error details
- Uses SHA-256 of actual file content (not claimed hash) to prevent cache poisoning

**What Gets Cached:**

Only files that fail BCMR v2 schema validation. Valid files are not cached here (they're saved as JSON files, see below).

**Cache Structure:**

Stored in `.validation-cache.json` with entries containing:
- SHA-256 hash of content
- Source URL
- Validation errors
- Last checked timestamp
- Attempt count

**Important Design Detail:**

The cache uses the actual content hash (computed after download), not the claimed hash from the blockchain OP_RETURN. This prevents cache poisoning if blockchain data contains incorrect hashes.

### JSON File Cache

**Purpose:** Reuses previously downloaded BCMR registry files without re-fetching from the network.

**Storage Location:** Individual files in `bcmr-registries/{tokenId}.json`

**How It Works:**

Automatic for all `--fetch-json` and `--fetch-valid-json` operations:
- Before network fetch: checks if `{tokenId}.json` exists locally
- If exists: computes SHA-256 hash and compares to OP_RETURN hash
- Hash match → uses local file (skip network)
- Hash mismatch → fetches from network (file outdated/corrupted)

**What Gets Cached:**

Complete BCMR registry JSON files, stored with exact formatting to preserve hash integrity. Named by tokenId (transaction hash).

**Cache Verification:**

Hash-based verification ensures cached files are current and uncorrupted. The `--ignore-json-hash` flag allows storing files even when hash verification fails.

## IPFS Gateway Rewriting

### Overview

The IPFS gateway rewriting feature allows you to customize which IPFS gateways are used when fetching BCMR registry files. This is useful for:

- **Using private/local IPFS gateways** - Faster fetching via local nodes or private infrastructure
- **Gateway redundancy** - Route specific gateways to more reliable alternatives
- **Cost optimization** - Use free public gateways or self-hosted nodes
- **Compliance** - Ensure all IPFS traffic routes through approved gateways
- **Testing** - Point to test gateways during development

### How Gateway Detection Works

The tool automatically detects IPFS gateway URLs from blockchain data using two patterns:

**Path-style gateway URLs:**
```
https://ipfs.io/ipfs/QmHash/path/file.json
         ↑                ↑
     gateway          CID + path
```

**Subdomain-style gateway URLs:**
```
https://QmHash.ipfs.dweb.link/path/file.json
         ↑           ↑            ↑
       CID      .ipfs.   gateway    path
```

Detection is **structure-based**, not hardcoded. The tool recognizes any domain using these patterns, including:
- Public gateways (ipfs.io, dweb.link, gateway.pinata.cloud, etc.)
- Private gateways (192.168.1.100:8080, localhost:8080, etc.)
- Custom domains (my-ipfs.example.com, etc.)

### Three Gateway Rewriting Modes

#### 1. Default Gateway Configuration

Set which gateway is used for `ipfs://` URLs (blockchain data often uses `ipfs://` scheme).

**Usage:**
```bash
bch-ipfs-scrape --fetch-json --ipfs-gateway dweb.link
```

**Effect:**
- `ipfs://QmHash/file.json` → `https://dweb.link/ipfs/QmHash/file.json`
- `https://ipfs.io/ipfs/...` → No change (only affects `ipfs://` conversion)

**Default:** `ipfs.io`

**Supports private IPs:**
```bash
bch-ipfs-scrape --fetch-json --ipfs-gateway 192.168.1.100:8080
```

#### 2. Global Gateway Rewriting

Rewrite **all detected IPFS gateway URLs** to a single target gateway.

**Usage:**
```bash
bch-ipfs-scrape --fetch-json --rewrite-gateways --target-gateway gateway.pinata.cloud
```

**Effect:**
- `https://ipfs.io/ipfs/QmHash` → `https://gateway.pinata.cloud/ipfs/QmHash`
- `https://dweb.link/ipfs/QmHash` → `https://gateway.pinata.cloud/ipfs/QmHash`
- `https://QmHash.ipfs.cloudflare-ipfs.com` → `https://gateway.pinata.cloud/ipfs/QmHash`

**Requirements:**
- Must specify both `--rewrite-gateways` and `--target-gateway`
- Target can be private IP (e.g., `localhost:8080`, `192.168.1.100:8080`)

#### 3. Selective Gateway Mapping

Use a JSON file to map specific source gateways to destination gateways. This provides fine-grained control over gateway routing.

**Usage:**
```bash
bch-ipfs-scrape --fetch-json --gateway-mapping gateways.json
```

**Mapping file format (gateways.json):**
```json
{
  "ipfs.io": "dweb.link",
  "cloudflare-ipfs.com": "gateway.pinata.cloud",
  "gateway.pinata.cloud": "192.168.1.100:8080"
}
```

**Effect:**
- `https://ipfs.io/ipfs/QmHash` → `https://dweb.link/ipfs/QmHash`
- `https://cloudflare-ipfs.com/ipfs/QmHash` → `https://gateway.pinata.cloud/ipfs/QmHash`
- `https://gateway.pinata.cloud/ipfs/QmHash` → `https://192.168.1.100:8080/ipfs/QmHash`
- `https://other-gateway.com/ipfs/QmHash` → No change (not in mapping)

**Automatic normalization:**
- Protocol prefixes stripped: `https://ipfs.io` → `ipfs.io`
- Trailing slashes removed: `ipfs.io/` → `ipfs.io`
- Case-insensitive matching: `IPFS.IO` → `ipfs.io`
- Port numbers preserved: `192.168.1.100:8080` stays as-is

### Rewriting Priority

When multiple rewriting options are configured, they are applied in this priority order:

1. **Gateway mapping** (highest priority)
   - If source gateway matches a mapping entry, use the mapped destination

2. **Global rewrite** (medium priority)
   - If `--rewrite-gateways` is enabled and no mapping matches, use `--target-gateway`

3. **No change** (lowest priority)
   - If no rules apply, URL remains unchanged

**Example with multiple rules:**
```bash
bch-ipfs-scrape --fetch-json \
  --ipfs-gateway localhost:8080 \
  --rewrite-gateways \
  --target-gateway dweb.link \
  --gateway-mapping gateways.json
```

With `gateways.json`:
```json
{
  "ipfs.io": "gateway.pinata.cloud"
}
```

**Results:**
- `ipfs://QmHash` → `https://localhost:8080/ipfs/QmHash` (default gateway)
- `https://ipfs.io/ipfs/QmHash` → `https://gateway.pinata.cloud/ipfs/QmHash` (mapping wins)
- `https://cloudflare-ipfs.com/ipfs/QmHash` → `https://dweb.link/ipfs/QmHash` (global rewrite)
- `https://other.com/ipfs/QmHash` → `https://dweb.link/ipfs/QmHash` (global rewrite)
- `https://example.com/file.json` → No change (not a gateway URL)

### Output Format

All rewritten URLs are converted to **path-style format** for maximum compatibility:

**Input (various formats):**
```
ipfs://QmHash/path
https://ipfs.io/ipfs/QmHash/path
https://QmHash.ipfs.dweb.link/path
```

**Output (always path-style):**
```
https://target-gateway.com/ipfs/QmHash/path
```

This ensures consistent URL formatting regardless of input format.

### Security Considerations

#### User-Configured Gateways Are Trusted

**Private IPs allowed** in gateway configuration:
- `--ipfs-gateway 192.168.1.100:8080` ✅
- `--target-gateway localhost:8080` ✅
- `--gateway-mapping` with private IPs ✅

**Rationale:** User-configured gateways are an explicit choice, not untrusted blockchain data.

#### Blockchain-Sourced URLs Are Validated

**SSRF protection** for URLs from blockchain (before rewriting):
- Internal/private IPs blocked: `http://localhost`, `http://192.168.1.1` ❌
- Only standard ports allowed: `https://example.com:8080` ❌

**Rationale:** Blockchain data is untrusted and could contain malicious URLs targeting internal services.

#### Rewriting Bypasses SSRF Checks

After blockchain URLs pass initial validation, gateway rewriting can redirect to private IPs:

1. Blockchain URL validated: `https://ipfs.io/ipfs/QmHash` ✅ (passes SSRF check)
2. Rewritten to: `https://192.168.1.100:8080/ipfs/QmHash` ✅ (user-configured, trusted)

This design allows using private gateways while protecting against SSRF attacks.

### Complete Usage Examples

#### Use Local IPFS Gateway

```bash
# Start local IPFS daemon
ipfs daemon

# Fetch using local gateway (much faster for pinned content)
bch-ipfs-scrape --fetch-json --ipfs-gateway localhost:8080
```

#### Route All Traffic Through Private Gateway

```bash
# Rewrite all IPFS gateway URLs to private infrastructure
bch-ipfs-scrape --fetch-json \
  --rewrite-gateways \
  --target-gateway 192.168.1.100:8080
```

#### Selective Gateway Routing

Create `gateways.json`:
```json
{
  "ipfs.io": "dweb.link",
  "cloudflare-ipfs.com": "gateway.pinata.cloud",
  "slow-gateway.com": "192.168.1.100:8080"
}
```

Run:
```bash
bch-ipfs-scrape --fetch-json --gateway-mapping gateways.json
```

#### Combined Configuration

```bash
# Complex routing setup:
# - ipfs:// uses local gateway
# - ipfs.io routes to Pinata
# - All others route to dweb.link
bch-ipfs-scrape --fetch-json \
  --ipfs-gateway localhost:8080 \
  --rewrite-gateways \
  --target-gateway dweb.link \
  --gateway-mapping <(echo '{"ipfs.io":"gateway.pinata.cloud"}')
```

#### Full Workflow with Gateway Rewriting

```bash
# Complete workflow using custom gateways
bch-ipfs-scrape \
  --query-chaingraph \
  --authchain-resolve \
  --fetch-json \
  --ipfs-gateway localhost:8080 \
  --rewrite-gateways \
  --target-gateway dweb.link \
  --export-bcmr-ipfs-cids \
  --export-cashtoken-ipfs-cids \
  --ipfs-pin
```

### Gateway Mapping File Format

**Basic structure:**
```json
{
  "source-gateway-1": "destination-gateway-1",
  "source-gateway-2": "destination-gateway-2"
}
```

**Valid entries:**
```json
{
  "ipfs.io": "dweb.link",
  "https://ipfs.io/": "dweb.link",
  "IPFS.IO": "dweb.link",
  "192.168.1.100:8080": "localhost:9000",
  "cloudflare-ipfs.com": "gateway.pinata.cloud"
}
```

All entries above normalize to the same source (`ipfs.io`) → destination (`dweb.link`) mapping.

**Invalid entries:**
```json
{
  "ipfs.io": ["dweb.link", "backup.link"],  // ❌ Value must be string
  "sources": { "ipfs.io": "dweb.link" }      // ❌ Must be flat object
}
```

**File validation:**
- Must be valid JSON
- Must be an object (not array)
- All values must be strings
- Empty sources/destinations rejected after normalization

**Error handling:**
- File not found: Error and exit
- Invalid JSON: Error and exit
- Invalid format: Error with details and exit

### Troubleshooting

**"--rewrite-gateways requires --target-gateway to be specified"**
- Solution: Add `--target-gateway <domain>` when using `--rewrite-gateways`

**Gateway mapping file not loading:**
- Check file exists: `ls -la gateways.json`
- Validate JSON: `cat gateways.json | jq .`
- Check file permissions

**URLs not being rewritten:**
- Enable verbose mode: `--verbose`
- Check URL format matches gateway patterns
- Verify mapping keys match detected gateway domains (case-insensitive)

**Connection errors with private gateways:**
- Verify gateway is accessible: `curl http://192.168.1.100:8080/ipfs/QmTest`
- Check firewall rules
- Ensure gateway port is correct

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
| `--ipfs-gateway <domain>` | Default gateway for ipfs:// URLs | `ipfs.io` | Any domain or IP:port |
| `--rewrite-gateways` | Enable global gateway rewriting | false | Flag (requires `--target-gateway`) |
| `--target-gateway <domain>` | Target gateway for global rewrite | - | Any domain or IP:port |
| `--gateway-mapping <file>` | JSON file with gateway mappings | - | Path to JSON file |

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

The project includes automated tests using Vitest v4.

#### Running Tests

**Prerequisites:**
```bash
# Build the TypeScript source first
npm run build
```

**Available test commands:**
```bash
# Run all tests once
npm test

# Run tests in watch mode (auto-rerun on changes)
npm run test:watch

# Run tests with interactive web UI
npm run test:ui

# Run tests with coverage report
npm run test:coverage
```

**Run specific tests:**
```bash
# Run specific test file
npx vitest run tests/unit/gateway-rewrite.test.ts

# Run tests matching a pattern
npx vitest run --grep "cache"
```

#### Environment Requirements

Integration tests require environment variables in `.env`:

**FULCRUM_WS_URL** (required for authchain resolution tests):
```bash
FULCRUM_WS_URL=ws://your-fulcrum-server:50003
```

**CHAINGRAPH_URL** (required for Chaingraph query tests):
```bash
CHAINGRAPH_URL=http://your-chaingraph-server:8088/v1/graphql
```

Tests gracefully skip when environment variables are missing.

#### Test Coverage

The test suite includes:

**Integration tests** (`tests/integration/`):
- CLI version display
- Chaingraph querying with custom GraphQL
- Authchain resolution via Fulcrum
- Cache creation, updates, and invalidation
- Cache flags (`--clear-cache`, `--no-cache`)

**Unit tests** (`tests/unit/`):
- Gateway URL rewriting and normalization
- IPFS URI conversion (ipfs:// → https://)
- Gateway mapping file validation
- Private IP support for local gateways

#### Manual Testing

The tool can also be tested manually with different configurations:

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
