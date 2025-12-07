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

// Test input fixture and output file paths
const inputFixture = join(
  projectRoot,
  'tests/fixtures/chaingraph/sample-200-registries.json'
);
const testOutputFile = join(projectRoot, 'test-authhead.json');

// Skip test if FULCRUM_WS_URL is not configured
const shouldSkip = !process.env.FULCRUM_WS_URL;

// Cleanup after each test
afterEach(() => {
  if (existsSync(testOutputFile)) {
    unlinkSync(testOutputFile);
  }
});

test(
  '--authchain-resolve processes registries and creates authhead file',
  { skip: shouldSkip, timeout: 60000 },
  async () => {
    // Execute the CLI with --authchain-resolve using sample fixture
    const { stdout } = await execFileAsync(
      'node',
      [
        cliPath,
        '--authchain-resolve',
        '--chaingraph-result-file',
        inputFixture,
        '--authhead-file',
        testOutputFile,
      ],
      {
        env: { ...process.env },
        cwd: projectRoot,
      }
    );

    // Verify success message in output
    expect(stdout).toContain('Authchain resolution complete');

    // Verify the output file was created
    expect(existsSync(testOutputFile)).toBe(true);

    // Parse the JSON output
    const authheadData = JSON.parse(readFileSync(testOutputFile, 'utf-8'));

    // Verify it's an array
    expect(Array.isArray(authheadData)).toBe(true);

    // Verify at least 1 authhead entry exists
    expect(authheadData.length).toBeGreaterThanOrEqual(1);

    console.log(`  ✓ Created ${authheadData.length} authhead entries from 200 input registries`);
  }
);

test(
  '--authchain-resolve output has valid entry structure',
  { skip: shouldSkip, timeout: 60000 },
  async () => {
    // Execute the CLI with --authchain-resolve
    await execFileAsync(
      'node',
      [
        cliPath,
        '--authchain-resolve',
        '--chaingraph-result-file',
        inputFixture,
        '--authhead-file',
        testOutputFile,
      ],
      {
        env: { ...process.env },
        cwd: projectRoot,
      }
    );

    // Parse the output
    const authheadData = JSON.parse(readFileSync(testOutputFile, 'utf-8'));

    // Validate the first entry structure
    const firstEntry = authheadData[0];

    // Required fields
    expect(firstEntry).toHaveProperty('tokenId');
    expect(typeof firstEntry.tokenId).toBe('string');

    expect(firstEntry).toHaveProperty('authbase');
    expect(typeof firstEntry.authbase).toBe('string');

    expect(firstEntry).toHaveProperty('authhead');
    expect(typeof firstEntry.authhead).toBe('string');

    expect(firstEntry).toHaveProperty('hash');
    expect(typeof firstEntry.hash).toBe('string');

    expect(firstEntry).toHaveProperty('uris');
    expect(Array.isArray(firstEntry.uris)).toBe(true);
    expect(firstEntry.uris.length).toBeGreaterThan(0);

    expect(firstEntry).toHaveProperty('isActive');
    expect(typeof firstEntry.isActive).toBe('boolean');

    expect(firstEntry).toHaveProperty('authchainLength');
    expect(typeof firstEntry.authchainLength).toBe('number');

    console.log(`  ✓ Entry structure validated for tokenId ${firstEntry.tokenId.substring(0, 8)}...`);
  }
);

// Show helpful message if tests are skipped
if (shouldSkip) {
  console.log('\n⚠️  Authchain resolve tests skipped: FULCRUM_WS_URL not set in .env file\n');
}
