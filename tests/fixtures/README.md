# Test Fixtures

This directory contains sample data files used for testing. These are shortened versions of real-world data to keep tests fast and maintainable.

## Directory Structure

### `chaingraph/`
Chaingraph GraphQL query responses

**Example files to add:**
- `sample-query-result.json` - Truncated chaingraph-result.json with 2-3 registry entries
- `empty-result.json` - Empty query response (no registries found)
- `single-registry.json` - Minimal response with one registry

**Source:** Shorten your real `chaingraph-result.json` file

### `bcmr/`
BCMR registry JSON files for testing validation and parsing

**Positive test cases (valid):**
- `valid-registry.json` - Properly formatted BCMR file
- `minimal-registry.json` - Minimal valid BCMR structure

**Negative test cases (invalid/malicious):**
- `invalid-missing-fields.json` - Missing required fields
- `invalid-bad-schema.json` - Schema validation failures
- `malicious-prototype-pollution.json` - Contains `__proto__`, `constructor`, `prototype`
- `malicious-path-traversal.json` - Contains `../../` in token IDs

**Source:** Use downloaded files from `bcmr-registries/` directory

### `bytecode/`
Bitcoin Script OP_RETURN bytecode samples (hex format)

**Example files to add:**
- `valid-bcmr-opreturn.hex` - Valid BCMR OP_RETURN data (starts with 6a04424d52...)
- `invalid-opreturn.hex` - Malformed or non-BCMR bytecode
- `empty.hex` - Empty bytecode

**Source:** Extract from real blockchain transactions

### `cids/`
IPFS CID samples and URL lists

**Example files to add:**
- `valid-cids.txt` - List of valid IPFS CIDs (one per line)
- `mixed-urls.txt` - Various URL formats:
  - `ipfs://Qm...`
  - `https://ipfs.io/ipfs/Qm...`
  - `https://Qm....ipfs.dweb.link`
- `invalid-cids.txt` - Malformed CIDs for error handling tests

**Source:** Extract from `bcmr-ipfs-cids.txt` or `cashtoken-ipfs-cids.txt`

### `caches/`
Cache file samples

**Example files to add:**
- `sample-authchain-cache.json` - Pre-populated authchain cache with 2-3 entries
- `sample-validation-cache.json` - Pre-populated validation cache
- `empty-cache.json` - Empty but valid cache structure
- `corrupted-cache.json` - Malformed JSON for error handling

**Source:** Copy from `.authchain-cache.json` and `.validation-cache.json` in your working directory

## Usage in Tests

### Loading Fixtures

```typescript
import { readFileSync } from 'fs';
import { join } from 'path';

const fixturesDir = join(__dirname, '..', 'fixtures');

// Load JSON fixture
const chaingraphResult = JSON.parse(
  readFileSync(join(fixturesDir, 'chaingraph/sample-query-result.json'), 'utf-8')
);

// Load text fixture
const validCids = readFileSync(
  join(fixturesDir, 'cids/valid-cids.txt'),
  'utf-8'
).split('\n').filter(Boolean);

// Load hex/binary fixture
const bytecode = readFileSync(
  join(fixturesDir, 'bytecode/valid-bcmr-opreturn.hex'),
  'utf-8'
).trim();
```

## Best Practices

1. **Keep fixtures small** - Only include the minimum data needed for the test
2. **Use real data** - Base fixtures on actual production data (shortened)
3. **Name descriptively** - File names should indicate what they test
4. **Document edge cases** - Add comments in complex fixtures
5. **Version control** - Commit all fixtures so tests are reproducible
6. **Sanitize sensitive data** - Remove any private keys, tokens, or personal info

## Creating Fixtures

When creating fixture files from real data:

1. Take a real output file (e.g., `chaingraph-result.json`)
2. Copy the file structure
3. Reduce to 1-3 representative examples
4. Ensure the structure remains valid
5. Save to the appropriate fixtures subdirectory
6. Reference in your test files
