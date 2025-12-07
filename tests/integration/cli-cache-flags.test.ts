import { test, expect, afterEach } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, existsSync, rmSync, writeFileSync, mkdirSync } from 'fs';
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

// Test fixtures
const fixture100 = join(
  projectRoot,
  'tests/fixtures/chaingraph/sample-100-registries.json'
);
const fixture200 = join(
  projectRoot,
  'tests/fixtures/chaingraph/sample-200-registries.json'
);

// Test cache directory and files
const testCacheDir = join(projectRoot, 'test-cache-flags');
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
  '--clear-cache deletes cache and creates new one',
  { skip: shouldSkip, timeout: 120000 },
  async () => {
    // ========================================
    // SETUP: Create initial cache with 100 registries
    // ========================================
    console.log('\n  [Setup] Creating initial cache with 100 registries...');

    await execFileAsync(
      'node',
      [
        cliPath,
        '--authchain-resolve',
        '--chaingraph-result-file',
        fixture100,
        '--json-folder',
        testCacheDir,
        '--authhead-file',
        authheadFile,
        '--concurrency',
        '5',
      ],
      {
        env: { ...process.env },
        cwd: projectRoot,
        maxBuffer: 50 * 1024 * 1024,
      }
    );

    // Verify cache was created
    expect(existsSync(cacheFile)).toBe(true);
    const initialCache = JSON.parse(readFileSync(cacheFile, 'utf-8'));
    expect(Object.keys(initialCache.entries).length).toBe(100);
    console.log('  ✓ Initial cache created with 100 entries');

    // ========================================
    // TEST: Run with --clear-cache
    // ========================================
    console.log('  [Test] Running with --clear-cache...');

    const { stdout, stderr: _stderr } = await execFileAsync(
      'node',
      [
        cliPath,
        '--authchain-resolve',
        '--chaingraph-result-file',
        fixture100,
        '--json-folder',
        testCacheDir,
        '--authhead-file',
        authheadFile,
        '--clear-cache',
        '--concurrency',
        '5',
      ],
      {
        env: { ...process.env },
        cwd: projectRoot,
        maxBuffer: 50 * 1024 * 1024,
      }
    );

    // Verify cache was cleared
    expect(stdout).toContain('Authchain cache cleared');

    // Verify completion
    expect(stdout).toContain('Authchain resolution complete');

    // Verify new cache was created
    expect(existsSync(cacheFile)).toBe(true);
    const newCache = JSON.parse(readFileSync(cacheFile, 'utf-8'));
    expect(Object.keys(newCache.entries).length).toBe(100);

    console.log('  ✓ Cache was cleared and recreated with 100 entries');
  }
);

test(
  '--clear-cache without --authchain-resolve does nothing',
  { skip: shouldSkip, timeout: 60000 },
  async () => {
    // ========================================
    // SETUP: Create a cache file
    // ========================================
    console.log('\n  [Setup] Creating cache file...');

    await execFileAsync(
      'node',
      [
        cliPath,
        '--authchain-resolve',
        '--chaingraph-result-file',
        fixture100,
        '--json-folder',
        testCacheDir,
        '--authhead-file',
        authheadFile,
        '--concurrency',
        '5',
      ],
      {
        env: { ...process.env },
        cwd: projectRoot,
        maxBuffer: 50 * 1024 * 1024,
      }
    );

    expect(existsSync(cacheFile)).toBe(true);
    const cacheContent = readFileSync(cacheFile, 'utf-8');
    console.log('  ✓ Cache file created');

    // ========================================
    // TEST: Run --clear-cache without --authchain-resolve
    // ========================================
    console.log('  [Test] Running with --clear-cache only (no --authchain-resolve)...');

    // Run query-chaingraph with --clear-cache (should not clear)
    await execFileAsync(
      'node',
      [
        cliPath,
        '--query-chaingraph',
        '--chaingraph-result-file',
        join(testCacheDir, 'query-result.json'),
        '--clear-cache', // This should be ignored
      ],
      {
        env: { ...process.env },
        cwd: projectRoot,
        maxBuffer: 50 * 1024 * 1024,
      }
    );

    // Verify cache file still exists and is unchanged
    expect(existsSync(cacheFile)).toBe(true);
    const unchangedCache = readFileSync(cacheFile, 'utf-8');
    expect(unchangedCache).toBe(cacheContent);

    console.log('  ✓ Cache file unchanged (--clear-cache ignored without --authchain-resolve)');
  }
);

test(
  '--clear-cache when no cache exists',
  { skip: shouldSkip, timeout: 60000 },
  async () => {
    // ========================================
    // SETUP: Ensure no cache exists
    // ========================================
    console.log('\n  [Setup] Ensuring no cache exists...');

    if (existsSync(testCacheDir)) {
      rmSync(testCacheDir, { recursive: true, force: true });
    }

    expect(existsSync(cacheFile)).toBe(false);
    console.log('  ✓ No cache file exists');

    // ========================================
    // TEST: Run with --clear-cache when cache doesn't exist
    // ========================================
    console.log('  [Test] Running with --clear-cache (no existing cache)...');

    const { stdout, stderr: _stderr } = await execFileAsync(
      'node',
      [
        cliPath,
        '--authchain-resolve',
        '--chaingraph-result-file',
        fixture100,
        '--json-folder',
        testCacheDir,
        '--authhead-file',
        authheadFile,
        '--clear-cache',
        '--concurrency',
        '5',
      ],
      {
        env: { ...process.env },
        cwd: projectRoot,
        maxBuffer: 50 * 1024 * 1024,
      }
    );

    // Verify it logged that there was no cache to clear
    expect(stdout).toContain('No cache file to clear');

    // Verify completion
    expect(stdout).toContain('Authchain resolution complete');

    // Verify new cache was created
    expect(existsSync(cacheFile)).toBe(true);
    const newCache = JSON.parse(readFileSync(cacheFile, 'utf-8'));
    expect(Object.keys(newCache.entries).length).toBe(100);

    console.log('  ✓ No error when clearing non-existent cache, new cache created');
  }
);

test(
  '--no-cache bypasses reading cache',
  { skip: shouldSkip, timeout: 60000 },
  async () => {
    // ========================================
    // SETUP: Create cache with 100 registries
    // ========================================
    console.log('\n  [Setup] Creating cache with 100 registries...');

    await execFileAsync(
      'node',
      [
        cliPath,
        '--authchain-resolve',
        '--chaingraph-result-file',
        fixture100,
        '--json-folder',
        testCacheDir,
        '--authhead-file',
        authheadFile,
        '--concurrency',
        '5',
      ],
      {
        env: { ...process.env },
        cwd: projectRoot,
        maxBuffer: 50 * 1024 * 1024,
      }
    );

    expect(existsSync(cacheFile)).toBe(true);
    console.log('  ✓ Cache created with 100 entries');

    // ========================================
    // TEST: Run with --no-cache
    // ========================================
    console.log('  [Test] Running same 100 registries with --no-cache...');

    const { stdout, stderr: _stderr } = await execFileAsync(
      'node',
      [
        cliPath,
        '--authchain-resolve',
        '--chaingraph-result-file',
        fixture100,
        '--json-folder',
        testCacheDir,
        '--authhead-file',
        authheadFile,
        '--no-cache',
        '--concurrency',
        '5',
      ],
      {
        env: { ...process.env },
        cwd: projectRoot,
        maxBuffer: 50 * 1024 * 1024,
      }
    );

    // Verify cache was disabled
    expect(stdout).toContain('Authchain cache disabled (--no-cache)');

    // Verify completion
    expect(stdout).toContain('Authchain resolution complete');

    console.log('  ✓ Cache was bypassed (not read)');
  }
);

test(
  '--no-cache does not write cache',
  { skip: shouldSkip, timeout: 60000 },
  async () => {
    // ========================================
    // SETUP: Ensure no cache exists
    // ========================================
    console.log('\n  [Setup] Ensuring no cache exists...');

    if (existsSync(testCacheDir)) {
      rmSync(testCacheDir, { recursive: true, force: true });
    }

    // Create the directory (needed for authhead.json output)
    mkdirSync(testCacheDir, { recursive: true });

    expect(existsSync(cacheFile)).toBe(false);
    console.log('  ✓ No cache file exists');

    // ========================================
    // TEST: Run with --no-cache
    // ========================================
    console.log('  [Test] Running with --no-cache...');

    const { stdout, stderr: _stderr } = await execFileAsync(
      'node',
      [
        cliPath,
        '--authchain-resolve',
        '--chaingraph-result-file',
        fixture100,
        '--json-folder',
        testCacheDir,
        '--authhead-file',
        authheadFile,
        '--no-cache',
        '--concurrency',
        '5',
      ],
      {
        env: { ...process.env },
        cwd: projectRoot,
        maxBuffer: 50 * 1024 * 1024,
      }
    );

    // Verify cache was disabled
    expect(stdout).toContain('Authchain cache disabled (--no-cache)');

    // Verify completion
    expect(stdout).toContain('Authchain resolution complete');

    // Verify no cache file was created
    expect(existsSync(cacheFile)).toBe(false);

    console.log('  ✓ No cache file created (--no-cache prevented write)');
  }
);

test(
  '--no-cache preserves existing cache',
  { skip: shouldSkip, timeout: 120000 },
  async () => {
    // ========================================
    // SETUP: Create cache with 100 registries
    // ========================================
    console.log('\n  [Setup] Creating cache with 100 registries...');

    await execFileAsync(
      'node',
      [
        cliPath,
        '--authchain-resolve',
        '--chaingraph-result-file',
        fixture100,
        '--json-folder',
        testCacheDir,
        '--authhead-file',
        authheadFile,
        '--concurrency',
        '5',
      ],
      {
        env: { ...process.env },
        cwd: projectRoot,
        maxBuffer: 50 * 1024 * 1024,
      }
    );

    expect(existsSync(cacheFile)).toBe(true);
    const originalCache = JSON.parse(readFileSync(cacheFile, 'utf-8'));
    const originalCount = Object.keys(originalCache.entries).length;
    const originalFirstEntry = Object.keys(originalCache.entries)[0];
    const originalTimestamp = originalCache.entries[originalFirstEntry].lastCheckedTimestamp;

    expect(originalCount).toBe(100);
    console.log(`  ✓ Original cache created with ${originalCount} entries`);

    // Small delay to ensure timestamp would be different if cache were updated
    await new Promise(resolve => setTimeout(resolve, 100));

    // ========================================
    // TEST: Run with --no-cache and 200 registries
    // ========================================
    console.log('  [Test] Processing 200 registries with --no-cache...');

    const { stdout, stderr: _stderr } = await execFileAsync(
      'node',
      [
        cliPath,
        '--authchain-resolve',
        '--chaingraph-result-file',
        fixture200,
        '--json-folder',
        testCacheDir,
        '--authhead-file',
        authheadFile,
        '--no-cache',
        '--concurrency',
        '5',
      ],
      {
        env: { ...process.env },
        cwd: projectRoot,
        maxBuffer: 50 * 1024 * 1024,
      }
    );

    // Verify cache was disabled
    expect(stdout).toContain('Authchain cache disabled (--no-cache)');

    // Verify completion
    expect(stdout).toContain('Authchain resolution complete');

    // Verify cache file is unchanged
    expect(existsSync(cacheFile)).toBe(true);
    const unchangedCache = JSON.parse(readFileSync(cacheFile, 'utf-8'));
    const unchangedCount = Object.keys(unchangedCache.entries).length;
    const unchangedTimestamp = unchangedCache.entries[originalFirstEntry].lastCheckedTimestamp;

    // Should still have 100 entries (not 200)
    expect(unchangedCount).toBe(100);

    // Timestamp should be unchanged
    expect(unchangedTimestamp).toBe(originalTimestamp);

    console.log(`  ✓ Cache unchanged (still ${unchangedCount} entries, timestamps preserved)`);
  }
);

test(
  '--clear-cache + --no-cache: deletes but does not recreate',
  { skip: shouldSkip, timeout: 60000 },
  async () => {
    // ========================================
    // SETUP: Create cache with 100 registries
    // ========================================
    console.log('\n  [Setup] Creating cache with 100 registries...');

    await execFileAsync(
      'node',
      [
        cliPath,
        '--authchain-resolve',
        '--chaingraph-result-file',
        fixture100,
        '--json-folder',
        testCacheDir,
        '--authhead-file',
        authheadFile,
        '--concurrency',
        '5',
      ],
      {
        env: { ...process.env },
        cwd: projectRoot,
        maxBuffer: 50 * 1024 * 1024,
      }
    );

    expect(existsSync(cacheFile)).toBe(true);
    console.log('  ✓ Cache created with 100 entries');

    // ========================================
    // TEST: Run with both --clear-cache and --no-cache
    // ========================================
    console.log('  [Test] Running with both --clear-cache and --no-cache...');

    const { stdout, stderr: _stderr } = await execFileAsync(
      'node',
      [
        cliPath,
        '--authchain-resolve',
        '--chaingraph-result-file',
        fixture100,
        '--json-folder',
        testCacheDir,
        '--authhead-file',
        authheadFile,
        '--clear-cache',
        '--no-cache',
        '--concurrency',
        '5',
      ],
      {
        env: { ...process.env },
        cwd: projectRoot,
        maxBuffer: 50 * 1024 * 1024,
      }
    );

    // Verify cache was cleared
    expect(stdout).toContain('Authchain cache cleared');

    // Verify cache was disabled
    expect(stdout).toContain('Authchain cache disabled (--no-cache)');

    // Verify completion
    expect(stdout).toContain('Authchain resolution complete');

    // Verify no cache file exists (cleared and not recreated)
    expect(existsSync(cacheFile)).toBe(false);

    console.log('  ✓ Cache was deleted and not recreated');
  }
);

// Show helpful message if tests are skipped
if (shouldSkip) {
  console.log('\n⚠️  Cache flag tests skipped: FULCRUM_WS_URL not set in .env file\n');
}
