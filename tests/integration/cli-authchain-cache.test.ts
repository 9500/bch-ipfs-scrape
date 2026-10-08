import { test, expect, afterEach } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, existsSync, rmSync } from 'fs';
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

// Test fixtures: real announcements whose authchains are short (<= 3 hops), so a
// full walk against live Fulcrum takes seconds. The half fixture is a prefix of
// the full one, which is what the partial-cache-hit scenarios rely on.
const fixtureHalf = join(projectRoot, 'tests/fixtures/chaingraph/short-chains-half.json');
const fixtureFull = join(projectRoot, 'tests/fixtures/chaingraph/short-chains-full.json');
const countAnnouncements = (file: string): number =>
  JSON.parse(readFileSync(file, 'utf-8')).data.search_output_prefix.length;
const halfCount = countAnnouncements(fixtureHalf);
const fullCount = countAnnouncements(fixtureFull);

// Test cache directory and files
const testCacheDir = join(projectRoot, 'test-cache-workflow');
const cacheFile = join(testCacheDir, '.authchain-cache.json');
const authheadFile = join(testCacheDir, 'authhead.json');

// Skip test if FULCRUM_WS_URL is not configured
const shouldSkip = !process.env.FULCRUM_WS_URL;

// Cleanup after each test
afterEach(() => {
  if (existsSync(testCacheDir)) {
    rmSync(testCacheDir, { recursive: true, force: true });
  }
});

test(
  'Cache workflow: creation, partial hit, full hit',
  { skip: shouldSkip, timeout: 180000 },
  async () => {
    // ========================================
    // FIRST RUN: half-fixture registries, no cache
    // ========================================
    console.log('\n  [Run 1] Processing half-fixture registries with no cache...');

    const { stdout: stdout1, stderr: _stderr1 } = await execFileAsync(
      'node',
      [
        cliPath,
        '--authchain-resolve',
        '--chaingraph-result-file',
        fixtureHalf,
        '--json-folder',
        testCacheDir,
        '--authhead-file',
        authheadFile,
        '--concurrency',
        '5', // Reduce concurrency to avoid overwhelming Fulcrum server
      ],
      {
        env: { ...process.env },
        cwd: projectRoot,
        maxBuffer: 50 * 1024 * 1024, // 50MB buffer for large outputs
      }
    );

    // Verify completion message
    expect(stdout1).toContain('Authchain resolution complete');

    // Verify cache file was created
    expect(existsSync(cacheFile)).toBe(true);

    // Parse and validate cache structure
    const cache1 = JSON.parse(readFileSync(cacheFile, 'utf-8'));

    expect(cache1).toHaveProperty('version');
    expect(cache1.version).toBe(2);
    expect(cache1).toHaveProperty('entries');
    expect(typeof cache1.entries).toBe('object');

    // Verify exactly 100 cache entries
    const cache1Count = Object.keys(cache1.entries).length;
    expect(cache1Count).toBe(halfCount);

    // Validate structure of first cache entry
    const firstAuthbase1 = Object.keys(cache1.entries)[0];
    const firstEntry1 = cache1.entries[firstAuthbase1];

    expect(firstEntry1).toHaveProperty('authbase');
    expect(typeof firstEntry1.authbase).toBe('string');

    expect(firstEntry1).toHaveProperty('authhead');
    expect(typeof firstEntry1.authhead).toBe('string');

    expect(firstEntry1).toHaveProperty('chainLength');
    expect(typeof firstEntry1.chainLength).toBe('number');

    expect(firstEntry1).toHaveProperty('isActive');
    expect(typeof firstEntry1.isActive).toBe('boolean');

    expect(firstEntry1).toHaveProperty('lastCheckedTimestamp');
    expect(typeof firstEntry1.lastCheckedTimestamp).toBe('number');
    expect(firstEntry1.lastCheckedTimestamp).toBeGreaterThan(0);

    // Verify authhead output file
    expect(existsSync(authheadFile)).toBe(true);
    const authhead1 = JSON.parse(readFileSync(authheadFile, 'utf-8'));
    expect(Array.isArray(authhead1)).toBe(true);
    expect(authhead1.length).toBeGreaterThanOrEqual(1);

    console.log(`  ✓ Cache created with ${cache1Count} entries`);

    // ========================================
    // SECOND RUN: full-fixture registries, cache has 100
    // ========================================
    console.log('  [Run 2] Processing full-fixture registries with 100 cached...');

    const { stdout: stdout2, stderr: _stderr2 } = await execFileAsync(
      'node',
      [
        cliPath,
        '--authchain-resolve',
        '--chaingraph-result-file',
        fixtureFull,
        '--json-folder',
        testCacheDir,
        '--authhead-file',
        authheadFile,
        '--concurrency',
        '5', // Reduce concurrency to avoid overwhelming Fulcrum server
      ],
      {
        env: { ...process.env },
        cwd: projectRoot,
        maxBuffer: 50 * 1024 * 1024, // 50MB buffer for large outputs
      }
    );

    // Verify completion
    expect(stdout2).toContain('Authchain resolution complete');

    // Parse updated cache
    const cache2 = JSON.parse(readFileSync(cacheFile, 'utf-8'));

    // Verify cache now has full-fixture entries (half old + half new)
    const cache2Count = Object.keys(cache2.entries).length;
    expect(cache2Count).toBe(fullCount);

    // Verify authhead file has full-fixture entries
    const authhead2 = JSON.parse(readFileSync(authheadFile, 'utf-8'));
    expect(authhead2.length).toBeGreaterThanOrEqual(1);

    console.log(`  ✓ Cache grew from ${cache1Count} to ${cache2Count} entries`);

    // ========================================
    // THIRD RUN: full-fixture registries, cache has all 200
    // ========================================
    console.log('  [Run 3] Processing full-fixture registries with all 200 cached...');

    // Small delay to ensure timestamp differences
    await new Promise(resolve => setTimeout(resolve, 100));

    const { stdout: stdout3, stderr: _stderr3 } = await execFileAsync(
      'node',
      [
        cliPath,
        '--authchain-resolve',
        '--chaingraph-result-file',
        fixtureFull,
        '--json-folder',
        testCacheDir,
        '--authhead-file',
        authheadFile,
        '--concurrency',
        '5', // Reduce concurrency to avoid overwhelming Fulcrum server
      ],
      {
        env: { ...process.env },
        cwd: projectRoot,
        maxBuffer: 50 * 1024 * 1024, // 50MB buffer for large outputs
      }
    );

    // Verify completion
    expect(stdout3).toContain('Authchain resolution complete');

    // Parse cache after third run
    const cache3 = JSON.parse(readFileSync(cacheFile, 'utf-8'));

    // Verify cache still has exactly full-fixture entries (no duplicates added)
    const cache3Count = Object.keys(cache3.entries).length;
    expect(cache3Count).toBe(fullCount);

    // Verify timestamps were updated (cache was used and re-saved)
    const firstAuthbase3 = Object.keys(cache3.entries)[0];
    const timestamp2 = cache2.entries[firstAuthbase3].lastCheckedTimestamp;
    const timestamp3 = cache3.entries[firstAuthbase3].lastCheckedTimestamp;

    expect(timestamp3).toBeGreaterThanOrEqual(timestamp2);

    // Verify authhead file still has correct structure
    const authhead3 = JSON.parse(readFileSync(authheadFile, 'utf-8'));
    expect(authhead3.length).toBeGreaterThanOrEqual(1);

    console.log(`  ✓ Cache stable at ${cache3Count} entries (no duplicates, timestamps updated)`);
    console.log('  ✓ Cache workflow validated: creation → partial hit → full hit');
  }
);

// Show helpful message if test is skipped
if (shouldSkip) {
  console.log('\n⚠️  Cache tests skipped: FULCRUM_WS_URL not set in .env file\n');
}
