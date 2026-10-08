/**
 * Authchain cache lifecycle and flags, against a fake Fulcrum.
 */
import { test, expect, describe, beforeAll, afterAll, afterEach } from 'vitest';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli, fixture, scratchDir, cleanupScratch } from '../helpers/cli.js';
import { startFakeFulcrum, loadFulcrumFixture, type FakeFulcrum } from '../helpers/fake-fulcrum.js';

// The half fixture is a prefix of the full one, which the partial-hit scenario relies on
const fixtureHalf = fixture('chaingraph/short-chains-half.json');
const fixtureFull = fixture('chaingraph/short-chains-full.json');
const count = (file: string): number => JSON.parse(readFileSync(file, 'utf-8')).data.search_output_prefix.length;
const halfCount = count(fixtureHalf);
const fullCount = count(fixtureFull);

let fulcrum: FakeFulcrum;

beforeAll(async () => {
  fulcrum = await startFakeFulcrum(loadFulcrumFixture(fixture('fulcrum/short-chains.json')));
});

afterAll(async () => {
  await fulcrum.close();
});

afterEach(() => {
  fulcrum.requests.length = 0;
  cleanupScratch();
});

interface Run {
  stdout: string;
  stderr: string;
  cache: { version: number; entries: Record<string, { authhead: string; chainLength: number; isActive: boolean; lastCheckedTimestamp: number; parentTxId?: string }> } | null;
  authhead: unknown[] | null;
  electrumCalls: number;
}

/** Run --authchain-resolve in `dir` and return what it produced */
async function resolve(dir: string, input: string, extra: string[] = []): Promise<Run> {
  const before = fulcrum.requests.length;
  const { stdout, stderr } = await runCli(
    ['--authchain-resolve', '--resolve-via', 'fulcrum', '--chaingraph-result-file', input, '--json-folder', dir, '--authhead-file', join(dir, 'authhead.json'), ...extra],
    { cwd: dir, fulcrumUrl: fulcrum.url }
  );
  const cacheFile = join(dir, '.authchain-cache.json');
  const authheadFile = join(dir, 'authhead.json');
  return {
    stdout,
    stderr,
    cache: existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf-8')) : null,
    authhead: existsSync(authheadFile) ? JSON.parse(readFileSync(authheadFile, 'utf-8')) : null,
    electrumCalls: fulcrum.requests.length - before,
  };
}

describe('cache workflow', () => {
  test('creation, partial hit, full hit', async () => {
    const dir = scratchDir();

    // Run 1: half fixture, no cache yet
    const run1 = await resolve(dir, fixtureHalf);
    expect(run1.stdout).toContain('Authchain resolution complete');
    expect(run1.cache?.version).toBe(2);
    expect(Object.keys(run1.cache!.entries)).toHaveLength(halfCount);
    const entry = Object.values(run1.cache!.entries)[0];
    expect(entry.authhead).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof entry.chainLength).toBe('number');
    expect(typeof entry.isActive).toBe('boolean');
    expect(entry.lastCheckedTimestamp).toBeGreaterThan(0);
    expect(run1.authhead!.length).toBeGreaterThan(0);
    expect(run1.stdout).toMatch(new RegExp(`Misses: ${halfCount} `));

    // Run 2: full fixture; the first half are cache hits, the rest misses
    const run2 = await resolve(dir, fixtureFull);
    expect(Object.keys(run2.cache!.entries)).toHaveLength(fullCount);
    expect(run2.stdout).toMatch(new RegExp(`Good hits: ${halfCount} `));
    expect(run2.stdout).toMatch(new RegExp(`Misses: ${fullCount - halfCount} `));
    expect(run2.electrumCalls).toBeLessThan(run1.electrumCalls + run1.electrumCalls); // hits are cheaper than a walk

    // Run 3: everything cached; one "still unspent?" lookup per announcement, no tokenId lookups
    const run3 = await resolve(dir, fixtureFull);
    expect(Object.keys(run3.cache!.entries)).toHaveLength(fullCount);
    expect(run3.stdout).toMatch(new RegExp(`Good hits: ${fullCount} `));
    expect(run3.stdout).toContain('Token ID lookups: 0');
    expect(run3.electrumCalls).toBeLessThan(run2.electrumCalls);
    // Timestamps advance and the parent txid is remembered
    const [txid, cached3] = Object.entries(run3.cache!.entries)[0];
    expect(cached3.lastCheckedTimestamp).toBeGreaterThanOrEqual(run2.cache!.entries[txid].lastCheckedTimestamp);
    expect(Object.values(run3.cache!.entries).some((e) => e.parentTxId)).toBe(true);
    expect(run3.authhead).toEqual(run2.authhead);
  });

  test('a version-1 cache is discarded and rebuilt', async () => {
    const dir = scratchDir();
    mkdirSync(dir, { recursive: true });
    const stale = { version: 1, entries: { deadbeef: { authbase: 'deadbeef', authhead: 'deadbeef', chainLength: 1, isActive: false, lastCheckedTimestamp: 1 } } };
    writeFileSync(join(dir, '.authchain-cache.json'), JSON.stringify(stale));

    const run = await resolve(dir, fixtureHalf);
    expect(run.stderr).toContain('version 1 is not supported'); // warnings go to stderr
    expect(run.cache?.version).toBe(2);
    expect(run.cache!.entries.deadbeef).toBeUndefined();
    expect(Object.keys(run.cache!.entries)).toHaveLength(halfCount);
  });
});

describe('--clear-cache and --no-cache', () => {
  test('--clear-cache deletes the cache and creates a new one', async () => {
    const dir = scratchDir();
    const first = await resolve(dir, fixtureHalf);
    expect(Object.keys(first.cache!.entries)).toHaveLength(halfCount);

    const second = await resolve(dir, fixtureHalf, ['--clear-cache']);
    expect(second.stdout).toContain('Authchain cache cleared');
    expect(second.stdout).toMatch(new RegExp(`Misses: ${halfCount} `)); // nothing was cached any more
    expect(Object.keys(second.cache!.entries)).toHaveLength(halfCount);
  });

  test('--clear-cache without --authchain-resolve leaves the cache alone', async () => {
    const dir = scratchDir();
    await resolve(dir, fixtureHalf);
    const cacheFile = join(dir, '.authchain-cache.json');
    const before = readFileSync(cacheFile, 'utf-8');

    // --export reads authhead.json only; --clear-cache must be ignored here
    const { stdout } = await runCli(['--export', 'ALL', '--authhead-file', join(dir, 'authhead.json'), '--export-file', join(dir, 'urls.txt'), '--json-folder', dir, '--clear-cache'], { cwd: dir });
    expect(stdout).not.toContain('Authchain cache cleared');
    expect(readFileSync(cacheFile, 'utf-8')).toBe(before);
  });

  test('--clear-cache when no cache exists', async () => {
    const dir = scratchDir();
    const run = await resolve(dir, fixtureHalf, ['--clear-cache']);
    expect(run.stdout).toContain('No cache file to clear');
    expect(run.stdout).toContain('Authchain resolution complete');
    expect(Object.keys(run.cache!.entries)).toHaveLength(halfCount);
  });

  test('--no-cache neither reads nor writes the cache', async () => {
    const dir = scratchDir();
    const run = await resolve(dir, fixtureHalf, ['--no-cache']);
    expect(run.stdout).toContain('Authchain cache disabled (--no-cache)');
    expect(run.stdout).toContain('Authchain resolution complete');
    expect(run.cache).toBeNull();
  });

  test('--no-cache preserves an existing cache byte for byte', async () => {
    const dir = scratchDir();
    await resolve(dir, fixtureHalf);
    const cacheFile = join(dir, '.authchain-cache.json');
    const before = readFileSync(cacheFile, 'utf-8');

    const run = await resolve(dir, fixtureFull, ['--no-cache']);
    expect(run.stdout).toContain('Authchain cache disabled (--no-cache)');
    expect(run.stdout).toMatch(new RegExp(`Found ${fullCount} BCMR announcements`));
    expect(readFileSync(cacheFile, 'utf-8')).toBe(before);
  });

  test('--clear-cache with --no-cache deletes but does not recreate', async () => {
    const dir = scratchDir();
    await resolve(dir, fixtureHalf);
    const run = await resolve(dir, fixtureHalf, ['--clear-cache', '--no-cache']);
    expect(run.stdout).toContain('Authchain cache cleared');
    expect(run.stdout).toContain('Authchain cache disabled (--no-cache)');
    expect(run.cache).toBeNull();
  });
});
