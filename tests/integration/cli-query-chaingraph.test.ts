import { test, expect, afterEach } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, existsSync, unlinkSync } from 'fs';
import dotenv from 'dotenv';

const execFileAsync = promisify(execFile);

// Get the project root directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..', '..');

// Path to the compiled CLI entry point
const cliPath = join(projectRoot, 'dist', 'index.js');

// Load environment variables
dotenv.config({ path: join(projectRoot, '.env') });

// Test output file path
const testOutputFile = join(projectRoot, 'test-chaingraph-result.json');

// Skip test if CHAINGRAPH_URL is not configured
const shouldSkip = !process.env.CHAINGRAPH_URL;

// Cleanup after each test
afterEach(() => {
  if (existsSync(testOutputFile)) {
    unlinkSync(testOutputFile);
  }
});

test(
  '--query-chaingraph fetches BCMR registries from live Chaingraph',
  { skip: shouldSkip, timeout: 30000 },
  async () => {
    // Execute the CLI with --query-chaingraph
    const { stdout, stderr } = await execFileAsync(
      'node',
      [
        cliPath,
        '--query-chaingraph',
        '--chaingraph-result-file',
        testOutputFile,
      ],
      {
        env: { ...process.env },
        cwd: projectRoot,
      }
    );

    // Verify the command completed successfully
    expect(stdout).toContain('Found');
    expect(stdout).toContain('BCMR outputs');

    // Verify the output file was created
    expect(existsSync(testOutputFile)).toBe(true);

    // Parse the JSON output
    const resultJson = JSON.parse(readFileSync(testOutputFile, 'utf-8'));

    // Validate top-level structure
    expect(resultJson).toHaveProperty('data');
    expect(resultJson.data).toHaveProperty('search_output_prefix');
    expect(Array.isArray(resultJson.data.search_output_prefix)).toBe(true);

    // Verify no GraphQL errors
    expect(resultJson.errors).toBeUndefined();

    // Verify we have at least 3000 BCMR registries
    const registries = resultJson.data.search_output_prefix;
    expect(registries.length).toBeGreaterThanOrEqual(3000);

    console.log(`  ✓ Found ${registries.length} BCMR registries`);
  }
);

test(
  '--query-chaingraph returns valid registry structure',
  { skip: shouldSkip, timeout: 30000 },
  async () => {
    // Execute the CLI with --query-chaingraph
    await execFileAsync(
      'node',
      [
        cliPath,
        '--query-chaingraph',
        '--chaingraph-result-file',
        testOutputFile,
      ],
      {
        env: { ...process.env },
        cwd: projectRoot,
      }
    );

    // Parse the JSON output
    const resultJson = JSON.parse(readFileSync(testOutputFile, 'utf-8'));
    const registries = resultJson.data.search_output_prefix;

    // Verify at least one registry exists
    expect(registries.length).toBeGreaterThan(0);

    // Validate the structure of the first registry entry
    const firstRegistry = registries[0];

    // Required fields (Chaingraph may return numbers as strings)
    expect(firstRegistry).toHaveProperty('locking_bytecode');
    expect(typeof firstRegistry.locking_bytecode).toBe('string');
    expect(firstRegistry.locking_bytecode.length).toBeGreaterThan(0);

    expect(firstRegistry).toHaveProperty('output_index');
    expect(firstRegistry.output_index).toBeDefined();

    expect(firstRegistry).toHaveProperty('transaction_hash');
    expect(typeof firstRegistry.transaction_hash).toBe('string');
    expect(firstRegistry.transaction_hash).toMatch(/^\\x[0-9a-f]+$/i); // hex string with \x prefix

    expect(firstRegistry).toHaveProperty('value_satoshis');
    expect(firstRegistry.value_satoshis).toBeDefined();

    // Transaction object
    expect(firstRegistry).toHaveProperty('transaction');
    expect(typeof firstRegistry.transaction).toBe('object');
    expect(firstRegistry.transaction).toHaveProperty('block_inclusions');
    expect(Array.isArray(firstRegistry.transaction.block_inclusions)).toBe(true);

    // Spent_by can be null, empty array, or object
    expect(firstRegistry).toHaveProperty('spent_by');
    // If spent_by exists and is an object (not null or empty array), validate its structure
    if (firstRegistry.spent_by && typeof firstRegistry.spent_by === 'object' && !Array.isArray(firstRegistry.spent_by)) {
      expect(firstRegistry.spent_by).toHaveProperty('input_index');
      expect(firstRegistry.spent_by).toHaveProperty('transaction');
    }

    console.log(`  ✓ Registry structure validated for entry with tx ${firstRegistry.transaction_hash.substring(0, 8)}...`);
  }
);

// Show helpful message if tests are skipped
if (shouldSkip) {
  console.log('\n⚠️  Chaingraph tests skipped: CHAINGRAPH_URL not set in .env file\n');
}
