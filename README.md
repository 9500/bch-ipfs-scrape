# BCH IPFS BCMR Registry Scraping Tool

A Node.js tool for resolving, exporting, and fetching Bitcoin Cash Metadata Registry (BCMR) and NFT data from the blockchain.

## What is BCMR?

BCMR (Bitcoin Cash Metadata Registry) is a specification for publishing on-chain metadata about Bitcoin Cash tokens and identities. This tool queries the blockchain to find BCMR announcements, resolves authchains to find current registry states, and provides commands to export URLs and fetch registry JSON files.

## Quick Start

### Option 1: Download Pre-built Binary (Recommended)

1. **Download the latest release:**
   ```bash
   # For x64 systems
   wget https://github.com/9500/bch-ipfs-scrape/releases/latest/download/bch-ipfs-scrape-linux-x64
   chmod +x bch-ipfs-scrape-linux-x64
   sudo mv bch-ipfs-scrape-linux-x64 /usr/local/bin/bch-ipfs-scrape

   # Or for ARM64 systems
   wget https://github.com/9500/bch-ipfs-scrape/releases/latest/download/bch-ipfs-scrape-linux-arm64
   chmod +x bch-ipfs-scrape-linux-arm64
   sudo mv bch-ipfs-scrape-linux-arm64 /usr/local/bin/bch-ipfs-scrape
   ```

2. **Configure environment:**
   ```bash
   cp .env.example .env
   ```

3. **Edit `.env` with your endpoints:**
   ```
   CHAINGRAPH_URL=http://your-chaingraph-server:8088/v1/graphql
   FULCRUM_WS_URL=ws://your-fulcrum-server:50003
   # Optional: Set a working directory for all output files
   # BCMR_WORKDIR=/path/to/data
   ```

4. **Run the tool:**
   ```bash
   bch-ipfs-scrape --query-chaingraph --authchain-resolve
   ```

### Option 2: Build from Source

1. **Clone the repository:**
   ```bash
   git clone https://github.com/9500/bch-ipfs-scrape.git
   cd bch-ipfs-scrape
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure environment:**
   ```bash
   cp .env.example .env
   # Edit .env with your endpoints
   ```

4. **Build standalone binary:**
   ```bash
   # Build binary for current system
   npm run pkg:test
   ./test-binary --query-chaingraph --authchain-resolve

   # Or build for distribution (both x64 and arm64)
   npm run pkg
   ./bin/bch-ipfs-scrape-linux-x64 --query-chaingraph --authchain-resolve
   ```

   **Alternatively, run with Node.js:**
   ```bash
   npm run build
   npm start -- --query-chaingraph --authchain-resolve
   ```

### First Run

```bash
# Step 1: Query Chaingraph and save results (creates chaingraph-result.json)
bch-ipfs-scrape --query-chaingraph

# Step 2: Resolve authchains and create authhead.json
bch-ipfs-scrape --authchain-resolve

# Step 3: Export IPFS URLs
bch-ipfs-scrape --export IPFS

# Step 4: Fetch registry JSON files
bch-ipfs-scrape --fetch-json
```

## Features

- **Authchain Resolution** - Follows spending chains from authbase to authhead
- **URL Export** - Extract URLs from registries with protocol filtering (IPFS, HTTPS, OTHER, ALL)
- **JSON Fetching** - Download and validate registry JSON files with hash verification
- **CID Export** - Extract and deduplicate IPFS CIDs from both registry metadata and JSON content (supports ipfs:// URLs and HTTPS gateway URLs)
- **IPFS Pinning** - Pin CIDs from both sources using local IPFS daemon
- **Caching** - Automatically caches authchain resolution to speed up subsequent runs
- **Parallel Processing** - Configurable concurrency for blockchain queries

## Basic Commands

### Query Chaingraph

Query Chaingraph and save raw results (required first step):

```bash
# Query with default BCMR query
bch-ipfs-scrape --query-chaingraph

# Query with custom GraphQL query file
bch-ipfs-scrape --query-chaingraph custom-query.graphql
```

This creates `chaingraph-result.json` containing raw Chaingraph data.

### Resolve Authchains

Resolve authchains from Chaingraph results (requires `--query-chaingraph` to be run first):

```bash
bch-ipfs-scrape --authchain-resolve
```

This loads data from `chaingraph-result.json` and creates `authhead.json`.

Options:
- `--verbose` - Show detailed logging
- `--concurrency <num>` - Set parallel query limit (default: 50)
- `--no-cache` - Disable caching
- `--clear-cache` - Delete cache before running
- `--chaingraph-result-file <path>` - Custom path for Chaingraph results (default: ./chaingraph-result.json)

### Export URLs

Export URLs with protocol filtering:

```bash
# Export IPFS URLs only
bch-ipfs-scrape --export IPFS

# Export IPFS and HTTPS URLs
bch-ipfs-scrape --export IPFS,HTTPS

# Export all URLs
bch-ipfs-scrape --export ALL
```

### Export IPFS CIDs

Extract only IPFS CIDs (deduplicated and sorted):

```bash
bch-ipfs-scrape --export-bcmr-ipfs-cids
```

This extracts CIDs from:
- `ipfs://` URLs (e.g., `ipfs://QmHash/path`)
- HTTPS gateway URLs in path style (e.g., `https://ipfs.tapswap.cash/ipfs/QmHash/file.json`)
- HTTPS gateway URLs in subdomain style (e.g., `https://QmHash.ipfs.dweb.link/file.json`)
- IPNS URLs are automatically skipped

### Export CashToken IPFS CIDs

Extract IPFS CIDs from BCMR JSON files:

```bash
bch-ipfs-scrape --export-cashtoken-ipfs-cids
```

This recursively scans all BCMR JSON files and extracts CIDs from both `ipfs://` URLs and HTTPS gateway URLs.

### Fetch JSON Files

Download and validate registry JSON files:

```bash
bch-ipfs-scrape --fetch-json
```

### Pin IPFS CIDs

Pin CIDs using local IPFS daemon (uses cache to skip already-pinned CIDs):

```bash
# Pin from both default files (bcmr-ipfs-cids.txt and cashtoken-ipfs-cids.txt)
bch-ipfs-scrape --ipfs-pin

# Pin CIDs from a single file
bch-ipfs-scrape --ipfs-pin --ipfs-pin-file bcmr-ipfs-cids.txt

# Custom timeout and concurrency (defaults: 5s timeout, 5 concurrent pins)
bch-ipfs-scrape --ipfs-pin --ipfs-pin-timeout 10 --ipfs-pin-concurrency 10
```

Bash script alternative for sequential pinning:

```bash
./pin-cids.sh bcmr-ipfs-cids.txt          # 2s timeout
./pin-cids.sh bcmr-ipfs-cids.txt 10       # 10s timeout
```

## Common Workflows

### Complete Workflow (Recommended)

Query Chaingraph, resolve authchains, fetch JSON, export CIDs, and pin everything to IPFS:

```bash
bch-ipfs-scrape --query-chaingraph --authchain-resolve --fetch-json --export-bcmr-ipfs-cids --export-cashtoken-ipfs-cids --ipfs-pin
```

This command:
1. Queries Chaingraph and saves raw results
2. Resolves authchains from Chaingraph data
3. Fetches and validates BCMR JSON files
4. Exports IPFS CIDs from registry metadata
5. Exports IPFS CIDs from JSON file contents
6. Pins all CIDs to local IPFS daemon (automatically skips already-pinned CIDs using cache)

### Update Existing Data

Use caching to quickly update (subsequent runs are much faster):

```bash
bch-ipfs-scrape --query-chaingraph --authchain-resolve --fetch-json --export-bcmr-ipfs-cids --export-cashtoken-ipfs-cids --ipfs-pin
```

Cached components:
- Authchains (only queries new/changed chains)
- IPFS pins (skips already-pinned CIDs)

### Iterative Development Workflow

After the initial Chaingraph query, you can re-run authchain resolution without re-querying:

```bash
# First time: Query Chaingraph
bch-ipfs-scrape --query-chaingraph

# Subsequent runs: Just resolve authchains (much faster)
bch-ipfs-scrape --authchain-resolve --fetch-json --export-bcmr-ipfs-cids --export-cashtoken-ipfs-cids --ipfs-pin
```

This is useful for testing or when you want to modify the Chaingraph results before processing.

### Export and Pin CIDs

Export and pin from both sources (pins both files by default):

```bash
bch-ipfs-scrape --export-bcmr-ipfs-cids --export-cashtoken-ipfs-cids --ipfs-pin
```

Pin from a single file:

```bash
bch-ipfs-scrape --ipfs-pin --ipfs-pin-file bcmr-ipfs-cids.txt
```

### Custom Output Files

```bash
bch-ipfs-scrape --query-chaingraph --authchain-resolve \
  --export IPFS,HTTPS --export-file all-urls.txt \
  --export-bcmr-ipfs-cids --cids-file my-cids.txt
```

## Using Without Chaingraph Access

If you don't have access to a Chaingraph endpoint, you can manually query Chaingraph and use the saved results.

### Manual Chaingraph Query

1. **Visit the public Chaingraph interface:**
   Open [https://try.chaingraph.cash/](https://try.chaingraph.cash/) in your browser

2. **Execute the following GraphQL query:**

```graphql
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
```

3. **Save the JSON response:**
   Copy the entire JSON response and save it to a file named `chaingraph-result.json` in your working directory

4. **Run authchain resolution with the saved file:**

```bash
# CHAINGRAPH_URL is NOT required when using a pre-saved file
# Only FULCRUM_WS_URL is needed in your .env file
bch-ipfs-scrape --authchain-resolve --fetch-json --export-bcmr-ipfs-cids --export-cashtoken-ipfs-cids --ipfs-pin
```

**Note:** When using a pre-saved `chaingraph-result.json` file:
- The `CHAINGRAPH_URL` environment variable is **not required**
- Only `FULCRUM_WS_URL` is needed for authchain resolution
- You can skip the `--query-chaingraph` command entirely
- The tool will automatically load data from the existing `chaingraph-result.json` file

### Custom File Location

If you want to save the result to a different location:

```bash
# Save your manually queried results to a custom location
# Then specify it when running authchain resolution:
bch-ipfs-scrape --authchain-resolve --chaingraph-result-file ./my-data/manual-query.json
```

## Working Directory

By default, all output files are saved in the current working directory. You can specify a custom working directory using the `BCMR_WORKDIR` environment variable:

```bash
# Set in .env file
BCMR_WORKDIR=/home/user/bcmr-data

# Or set temporarily for a single command
BCMR_WORKDIR=./data bch-ipfs-scrape --authchain-resolve
```

When `BCMR_WORKDIR` is set:
- All output files and folders are saved relative to this directory
- The directory is automatically created if it doesn't exist
- Useful for organizing data or running multiple instances with different datasets

When `BCMR_WORKDIR` is not set:
- Files are saved in the current working directory (original behavior)
- Maintains backward compatibility with existing setups

## Output Files

- `chaingraph-result.json` - Raw Chaingraph query results (created by `--query-chaingraph`)
- `authhead.json` - Current registries: active + burned, excludes superseded (created by `--authchain-resolve`)
- `exported-urls.txt` - Exported URLs (created by `--export`)
- `bcmr-ipfs-cids.txt` - Exported IPFS CIDs from authhead.json (created by `--export-bcmr-ipfs-cids`)
- `cashtoken-ipfs-cids.txt` - Exported IPFS CIDs from JSON files (created by `--export-cashtoken-ipfs-cids`)
- `bcmr-registries/*.json` - Downloaded registry JSON files (created by `--fetch-json`)
- `bcmr-registries/.authchain-cache.json` - Authchain cache (auto-generated)
- `bcmr-registries/.ipfs-pin-cache.json` - IPFS pin cache (auto-generated)

**Note:** All output files are relative to `BCMR_WORKDIR` if specified, otherwise relative to the current directory.

## Requirements

**For pre-built binary:**
- Linux (x64 or ARM64)
- Access to a Chaingraph server (GraphQL endpoint)
- Access to a Fulcrum server (Electrum WebSocket endpoint)
- IPFS daemon (optional, for `--ipfs-pin` command)

**For building from source:**
- Node.js 20+
- All of the above

## Advanced Usage

For detailed information about caching, output formats, and advanced configuration, see [ADVANCED.md](ADVANCED.md).

## License

[MIT](LICENSE)
