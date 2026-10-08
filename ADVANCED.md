# Advanced Usage

This document provides detailed technical information about the BCMR Registry Tool.

## Table of Contents

- [Project Structure](#project-structure)
- [Working with Chaingraph Data](#working-with-chaingraph-data)
- [Resolution Sources](#resolution-sources)
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

### Result Size and Paging

Chaingraph's Hasura layer returns at most 5000 rows per request, silently. The default query therefore fetches BCMR outputs in pages of 1000, ordered by transaction hash and output index, until a short page comes back; the log shows the running count. A custom query file is sent as-is in a single request, so add `limit`/`offset` (and an `order_by`) to it yourself if the result can exceed 5000 rows.

### Embedded Resolution

By default `--query-chaingraph` makes a second pass after fetching the BCMR outputs: for every announcement transaction it asks Chaingraph for the resolved authchain (`transaction.authchains`: authhead, chain length, whether the authhead is unspent) and for the outpoint spent by input 0 (the token category), and stores them on the row's `transaction` object. The file also gets a `meta` block:

```json
{
  "meta": { "generatedAt": "2026-10-08T12:00:00.000Z", "embeddedResolution": true },
  "data": { "search_output_prefix": [ ... ] }
}
```

The pass has two phases. First, cheap batched queries fetch the spend status of output 0 and the input-0 outpoint for every announcement; an announcement whose output 0 is unspent is its own authhead (chain length 1) and needs nothing more. Only announcements whose output 0 is spent go to Chaingraph's recursive `authchains` query, in batches of 50. Identities whose auth UTXO was swept into busy wallet traffic have chains of hundreds of hops, and those batches can take tens of seconds, so a batch that fails or times out is split in half down to single transactions; a transaction Chaingraph still cannot resolve is skipped with a warning and left without embedded data (a live run resolves it later). A full run over a few thousand announcements takes several minutes. Pass `--no-embed-resolution` to skip the pass. A custom query file still gets the embedding pass as long as its rows have a `transaction_hash`.

A result file with embedded resolution is self-sufficient: anyone can run `--authchain-resolve` on it without Chaingraph or Fulcrum (see [Resolution Sources](#resolution-sources)).

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

## Resolution Sources

`--authchain-resolve` needs two answers per identity: which transaction currently holds the authhead (found by following output 0 from the announcement) and which output input 0 of the authbase spends (the token category). They can come from three places.

| `--resolve-via` | Source | Network | Freshness |
|---|---|---|---|
| `file` | Snapshot embedded in the Chaingraph result file | None | As of the file's `meta.generatedAt` |
| `chaingraph` | Live Chaingraph (`CHAINGRAPH_URL`) | One batched GraphQL request per hop level; long chains resolved server-side | Live |
| `fulcrum` | Live Fulcrum (`FULCRUM_WS_URL`) | Electrum RPC per hop (see [Fulcrum Client](#fulcrum-client)) | Live |
| `auto` (default) | Chaingraph if `CHAINGRAPH_URL` is set, with Fulcrum as fallback if `FULCRUM_WS_URL` is also set; else Fulcrum; else the snapshot | | |

**Snapshot as a seed.** When a live source is used and the file carries embedded resolution, the snapshot seeds the authchain cache: every announcement starts from its snapshot authhead, so an identity whose head did not move costs one "still unspent?" lookup instead of a walk, and the token category needs no lookup at all. Pass `--ignore-embedded` to walk every chain from scratch.

**Live Chaingraph.** Walks are driven by output-0 spend lookups batched across all in-flight chains (`output(where: {transaction_hash: {_in: [...]}, output_index: {_eq: "0"}}) { spent_by { transaction { hash } } }`), so each hop level is one request regardless of how busy the addresses are. After 25 hops in one run the remainder of the chain is handed to Chaingraph's server-side `transaction.authchains`, which is exact but expensive, so it is only paid for the few swept chains. Token categories come from `transaction.inputs`. When Fulcrum is also configured, any lookup Chaingraph fails is retried on Fulcrum and counted in the summary.

**Snapshot only.** With no live source every announcement is answered from its embedded data. The summary states that no blockchain queries were made and when the file was generated. Announcements without embedded data are reported as unresolved. The cache is written as usual, so a later run with a live source verifies instead of walking.

**Errors.** A lookup the source cannot answer (unknown transaction, timeout, HTTP or GraphQL error) aborts that announcement's walk; it is reported as unresolved, not cached, and retried on the next run. Chaingraph requests time out after `CHAINGRAPH_TIMEOUT_MS` (default 120000).

**Measured on the 200-announcement test fixture** (149 identities, including chains of 600 and 1127 hops), no cache, LAN endpoints:

| Source | Requests | Time | Unresolved |
|---|---|---|---|
| Fulcrum | 669,006 Electrum RPC calls | 114 s | 1 (chain over the 1000-hop cap) |
| Chaingraph | 123 GraphQL requests (41 chains finished server-side) | 2.7 s | 0 |
| Snapshot | 0 | under 1 s | 0 |

**Measured on the full chain** (5871 announcements, 3897 identities, longest chain 4770 hops), LAN endpoints:

| Step | Requests | Time |
|---|---|---|
| `--query-chaingraph` with embedding (producer, once per publish) | 6 pages + 60 spend/parent batches + 3263 server-side resolutions in batches of 50 | 11 min |
| `--authchain-resolve` from the snapshot only | 0 | 0.2 s |
| `--authchain-resolve --resolve-via fulcrum` (snapshot seeds, Fulcrum verifies) | 5985 Electrum RPC calls | 1.5 s |
| `--authchain-resolve` with Chaingraph (snapshot seeds, Chaingraph verifies) | 119 GraphQL requests | 0.8 s |

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

Every BCMR OP_RETURN output returned by Chaingraph is an *announcement*. An identity that has been updated N times has N announcements, and all of them walk forward (following the transaction that spends output 0) to the same unspent authhead. The tool resolves every announcement, groups them by authhead, and keeps the announcement closest to the head as the identity's current registry (see [Current Registry Criteria](#current-registry-criteria)).

Within a run, output-0 spend lookups are memoised, so the shared tail of an authchain is queried once no matter how many announcements the identity has. The token category (`tokenId`) is looked up once per identity rather than once per announcement. See [Fulcrum Client](#fulcrum-client) for how a single spend lookup is answered.

The cache stores the result of walking the authchain from each announcement transaction to the authhead. A walk that was aborted by a Fulcrum error is never cached: its authhead is unknown, the announcement is reported as unresolved, and the next run retries it. On subsequent runs:

1. **Perfect hits** - Inactive chains (exceeded the maximum chain length of 1000)
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

Each cache entry (one per announcement transaction) stores:
- Announcement transaction ID (the walk's starting point)
- Current authhead transaction ID
- Chain length (number of transactions from the announcement to the authhead, inclusive)
- Active status (whether authhead output is unspent)
- Last checked timestamp
- Parent transaction ID of the authbase (token category), once known, so later runs skip that lookup

**Cache Updates:**
- Cache is saved only on successful completion
- Interrupted runs do not corrupt the cache
- Atomic write ensures data integrity

**Cache Version:**

The cache file carries a `version` field (currently 2). A cache written by an older release is discarded with a warning and rebuilt on the next run. Version 1 caches could contain inactive entries produced by Fulcrum errors rather than by a finished walk, so they are not trusted.

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

Grouped 200 announcements into 149 identities
Authchain resolution complete in 0.17s (avg 1ms per announcement)
  148 current registries, 51 superseded announcements

Cache Performance:
  Perfect hits: 1 (0 lookups each)
  Good hits: 199 (1 lookup each)
  Partial hits: 0 (continued from cache)
  Misses: 0 (full authchain walk)
  Total: 200/200 cached (100.0%)

Fulcrum Query Statistics:
  Spend lookups: 199 (148 queries after memoisation)
  Token ID lookups: 149 (one per identity)
  Total queries: 297
  Average per announcement: 1.49
  Electrum RPC calls: 427
```

"Lookups" count the logical spend checks made while walking chains; "queries" count the spend checks actually performed after memoisation; "Electrum RPC calls" counts the requests sent to Fulcrum. A cached run costs about two RPC calls per identity (one transaction fetch and one `listunspent`) plus one per identity for the token ID.

A first run without a cache is far more expensive, because every chain is walked to its end. Auth UTXOs that were swept into an ordinary wallet produce chains hundreds of hops long through busy addresses, and finding each hop's spender means scanning the address history. For the 200-announcement test fixture, a cold run sends about 670,000 RPC calls and takes around two minutes against a LAN Fulcrum; the cached run above takes a fraction of a second.

### Fulcrum Client

**Purpose:** Answers the two questions authchain resolution asks Fulcrum: "which transaction spends output 0 of this transaction?" and "which output does input 0 of this transaction spend?" (for `tokenId`).

**Spend lookup:** A spend lookup first fetches the transaction to learn the script of output 0, then asks `blockchain.scripthash.listunspent` (with the `include_tokens` filter, since authhead outputs often carry CashTokens) whether that outpoint is still unspent. In the common case the answer is yes and the lookup is finished after two requests. Only when the outpoint is gone from the unspent set is the script history walked, fetching later transactions until the one spending the outpoint is found. OP_RETURN outputs are answered without any query, because they can never be spent.

Fulcrum 1.9.0 or newer is required for the `include_tokens` filter.

**Failure semantics:** Every request either returns the server's answer or fails; nothing is silently reported as "unspent".
- A request in flight on a connection that drops is re-sent once on another connection, then rejected.
- A request not answered within `FULCRUM_REQUEST_TIMEOUT_MS` (default 30000) is rejected and its connection is replaced.
- The connection pool is only used once every connection has opened. If any connection fails to open, the ones that did are closed and the next call retries from scratch.
- A failed spend lookup aborts that announcement's walk. The announcement is reported as unresolved, is not cached, and is excluded from `authhead.json` until a later run resolves it.

**Statistics:** The run summary prints the number of Electrum RPC calls actually sent, and warns when requests timed out, were dropped, or connections were lost.

Fulcrum is one of three resolution sources; see [Resolution Sources](#resolution-sources) for when it is used.

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

**Scheme:** a gateway given without a scheme is reached over `https://`. Prefix it with `http://` for a plain-HTTP gateway, such as a stock Kubo daemon on port 8080:
```bash
bch-ipfs-scrape --fetch-json --ipfs-gateway http://192.168.1.100:8080
```
- `ipfs://QmHash/file.json` → `http://192.168.1.100:8080/ipfs/QmHash/file.json`

**Supports private IPs** (with or without `http://`):
```bash
bch-ipfs-scrape --fetch-json --ipfs-gateway 192.168.1.100:8080   # https://192.168.1.100:8080/ipfs/...
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
- Sources (keys) are matched by host, so any scheme is dropped: `https://ipfs.io` → `ipfs.io`, `http://ipfs.io` → `ipfs.io`
- Destinations (values) drop `https://` (the default) but keep an explicit `http://`: `http://localhost:9000/` → `http://localhost:9000`
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
  --ipfs-gateway http://localhost:8080 \
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
- `ipfs://QmHash` → `http://localhost:8080/ipfs/QmHash` (default gateway)
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

**Private IPs and plain HTTP allowed** in gateway configuration:
- `--ipfs-gateway http://192.168.1.100:8080` ✅
- `--target-gateway http://localhost:8080` ✅
- `--gateway-mapping` with private IPs and `http://` destinations ✅

**Rationale:** User-configured gateways are an explicit choice, not untrusted blockchain data.

#### Blockchain-Sourced URLs Are Validated

**SSRF protection** for URLs from blockchain (before rewriting):
- Internal/private IPs blocked: `http://localhost`, `http://192.168.1.1`, `http://[::1]` ❌
- Only standard ports allowed: `https://example.com:8080` ❌
- Redirects are followed manually (max 5) and every hop is re-checked ❌ `302 → http://127.0.0.1/`
- Hostnames are resolved before connecting; names pointing at private IPs are refused ❌
- Response bodies are capped at `--max-file-size-mb` and the timeout covers the whole transfer

**Rationale:** Blockchain data is untrusted and could contain malicious URLs targeting internal services.

#### Rewriting Bypasses SSRF Checks

After blockchain URLs pass initial validation, gateway rewriting can redirect to private IPs:

1. Blockchain URL validated: `https://ipfs.io/ipfs/QmHash` ✅ (passes SSRF check)
2. Rewritten to: `https://192.168.1.100:8080/ipfs/QmHash` ✅ (user-configured, trusted)

This design allows using private gateways while protecting against SSRF attacks.

#### Trust Model

The security model distinguishes between two input sources:

**User input (TRUSTED):**
- Command-line arguments (`--ipfs-gateway`, `--target-gateway`, `--gateway-mapping`)
- Environment variables (`BCMR_WORKDIR`, `CHAINGRAPH_URL`, etc.)
- CID files that users can manually edit
- Gateway mapping JSON files

Users have local access and can configure the tool however they want, including rewriting to private gateways or modifying CID lists.

**Blockchain input (UNTRUSTED):**
- URLs from OP_RETURN data in BCMR transactions
- Hashes and metadata embedded in blockchain

This data is validated before use (see `src/lib/ssrf.ts`):
- `localhost` and `*.localhost` are blocked
- Private/reserved IPv4 ranges are blocked: 0/8, 10/8, 100.64/10 (CGNAT), 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.168/16, 198.18/15, 224/4, 240/4. Shorthand forms (`127.1`, `2130706433`, `0x7f000001`) are canonicalized by the URL parser and caught too
- Private/reserved IPv6 ranges are blocked: `::`, `::1`, fc00::/7, fe80::/10, fec0::/10, ff00::/8, plus IPv4 addresses embedded in IPv6 (`::ffff:a.b.c.d`, `::ffff:xxxx:xxxx`, NAT64 `64:ff9b::/96`)
- Non-standard ports are rejected (only ports 80/443 or no port allowed)
- Every redirect hop is validated the same way; the chain is capped at 5 hops
- The hostname is resolved via DNS before connecting and refused if any answer is a private address. A DNS-rebinding attacker who changes the answer between that lookup and the connection could still get through; treat this as defence in depth and run the tool on a host without sensitive services on its local network if that matters to you
- Response bodies are capped at `--max-file-size-mb` (default 50 MB) and the per-attempt timeout covers the body, not just the headers

Gateway rewriting happens AFTER blockchain validation, so user-configured rewrites to private IPs are allowed while direct blockchain access to internal services is blocked. Only the exact gateway host you configured is exempt from these checks; if your gateway redirects elsewhere, the redirect target is validated as untrusted.

### Complete Usage Examples

#### Use Local IPFS Gateway

```bash
# Start local IPFS daemon
ipfs daemon

# Fetch using the local gateway (much faster for pinned content).
# Kubo serves its gateway over plain HTTP, so give the scheme explicitly.
bch-ipfs-scrape --fetch-json --ipfs-gateway http://localhost:8080
```

#### Route All Traffic Through Private Gateway

```bash
# Rewrite all IPFS gateway URLs to private infrastructure (plain HTTP)
bch-ipfs-scrape --fetch-json \
  --rewrite-gateways \
  --target-gateway http://192.168.1.100:8080
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
  --ipfs-gateway http://localhost:8080 \
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
  --ipfs-gateway http://localhost:8080 \
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
- A gateway given without a scheme is contacted over `https://`; a stock Kubo gateway only speaks HTTP, so use `--ipfs-gateway http://192.168.1.100:8080`
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
| `--no-embed-resolution` | Do not embed authchain resolution when querying Chaingraph | false | Flag (no value) |
| `--resolve-via <source>` | Where `--authchain-resolve` gets blockchain answers | `auto` | `auto`, `file`, `chaingraph`, `fulcrum` |
| `--ignore-embedded` | Ignore resolution data embedded in the result file | false | Flag (no value) |
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
| `--ipfs-gateway <gateway>` | Default gateway for ipfs:// URLs | `ipfs.io` | Domain or IP:port, optionally prefixed with `http://` (default scheme is https) |
| `--rewrite-gateways` | Enable global gateway rewriting | false | Flag (requires `--target-gateway`) |
| `--target-gateway <gateway>` | Target gateway for global rewrite | - | Same format as `--ipfs-gateway` |
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

Array of current registry objects, one per identity (authchain):

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
    "authchainLength": 3,
    "isActive": true,
    "isBurned": false,
    "isValid": true
  }
]
```

**Fields:**
- `tokenId` - CashToken category ID: the transaction spent by input 0 of the `authbase`. This is the category when the first announcement is the token's genesis transaction (the common case). It is derived once per identity, never from an update transaction.
- `authbase` - Earliest BCMR announcement transaction of this identity (start of the authchain)
- `authhead` - Current head of the authchain: the transaction whose output 0 is unspent. It can be a transaction without a BCMR output if the authhead was moved without a new announcement.
- `blockHeight` - Block height of the transaction carrying the current announcement (the one whose `hash` and `uris` are listed)
- `hash` - SHA-256 hash of registry content, from the current announcement
- `uris` - Array of registry URIs, from the current announcement
- `authchainLength` - Number of transactions from `authbase` to `authhead`, inclusive (1 for an identity that was never updated)
- `isActive` - Whether authhead output 0 is unspent
- `isBurned` - Whether registry was burned (OP_RETURN at output 0, so it can never be updated)
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

Registry JSON files saved in `--json-folder`, named by token ID (one file per identity, since `authhead.json` holds one entry per identity):

```
bcmr-registries/
├── abc123def456.json
├── 789ghi012jkl.json
└── ...
```

Each file contains the validated BCMR registry data with hash verification.

## Filtering Rules

### Current Registry Criteria

Chaingraph returns every BCMR announcement ever made, including all older versions of identities that were later updated. `authhead.json` contains exactly one entry per identity: its current registry.

**How the current announcement is chosen:**

1. Every announcement transaction is walked forward (following whichever transaction spends output 0) until an unspent output 0 is found. That transaction is the authhead.
2. Announcements that reach the same authhead belong to the same identity (authchain).
3. Within an identity, the announcement closest to the authhead (smallest distance to it) is current. All other announcements of that identity are **superseded**.
4. `authbase` is the earliest announcement of the identity, `authchainLength` is the distance from `authbase` to `authhead`, and `tokenId` is derived from the `authbase`.

For a chain `A -> B -> C` where all three carry BCMR outputs, only C's hash and URIs are written, with `authbase = A`, `authhead = C`, `authchainLength = 3`.

**Included:**
- ✅ Current announcement of its identity (not superseded)
- ✅ Valid (`isValid === true`, has URIs and proper format)
- ✅ Either active OR burned:
  - **Active** (`!isBurned && isActive`): Can still be updated via authchain
  - **Burned** (`isBurned`): Finalized/immutable, cannot be updated

**Excluded:**
- ❌ **Superseded**: An older announcement of an identity that has a newer one on the same authchain
- ❌ **Invalid** (`!isValid`): The identity's current announcement is malformed or has no URIs
- ❌ **Unresolved** (`!isBurned && !isActive`): The authchain walk failed with a Fulcrum error or exceeded the maximum length (1000), so the authhead is unknown. Failed walks are not cached and are retried on the next run.

The `--authchain-resolve` output reports each of these counts.

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

None. The suite runs offline: unit tests use fake backends, and the integration tests start a fake Fulcrum (Electrum over WebSocket, answering from a recorded fixture) and a fake Chaingraph (GraphQL over HTTP) on random local ports, then run the built CLI against them. The fakes can drop sockets, leave requests unanswered and return RPC errors, so the failure paths are covered too. Test files run in parallel.

One opt-in smoke test exercises the real servers configured in `.env`:

```bash
LIVE_TESTS=1 npx vitest run tests/integration/live-smoke.test.ts
```

#### Test Coverage

The test suite includes:

**Integration tests** (`tests/integration/`, built CLI against local fakes):
- CLI version display
- Chaingraph querying: paging past the 5000-row cap, custom query files, missing endpoint
- Authchain resolution via Fulcrum: results, determinism, RPC errors, dropped sockets, timeouts
- Resolution from a result file with embedded data (no endpoints)
- Cache creation, partial and full hits, version migration, `--clear-cache`, `--no-cache`
- Live smoke test (opt-in)

**Unit tests** (`tests/unit/`):
- Fulcrum client against a fake Electrum server (drops, retries, timeouts, pool init, spend fast path)
- Chaingraph client against a fake GraphQL server (batching, errors, paging, embedding)
- Authchain grouping, superseded detection, resolution tiers and source selection
- Gateway URL rewriting and normalization, including plain-HTTP gateways
- SSRF protection and safe fetching

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

**"N announcements could not be resolved because of Fulcrum errors"**
- The affected announcements were left out of `authhead.json` and not cached; run `--authchain-resolve` again to retry them
- Run with `--verbose` to see the error for each announcement
- Slow server: raise `FULCRUM_REQUEST_TIMEOUT_MS` in `.env` or lower `--concurrency`
- "listunspent" errors: the `include_tokens` filter requires Fulcrum 1.9.0 or newer

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
