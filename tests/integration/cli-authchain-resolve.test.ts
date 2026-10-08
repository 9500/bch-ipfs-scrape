/**
 * --authchain-resolve against a fake Fulcrum served from a recorded fixture.
 * No network, deterministic, and the failure paths are testable.
 */
import { test, expect, describe, beforeAll, afterAll, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runCli, fixture, scratchDir, cleanupScratch } from '../helpers/cli.js';
import { startFakeFulcrum, loadFulcrumFixture, type FakeFulcrum } from '../helpers/fake-fulcrum.js';

const inputFixture = fixture('chaingraph/short-chains-full.json');
const announcementCount = JSON.parse(readFileSync(inputFixture, 'utf-8')).data.search_output_prefix.length;

let fulcrum: FakeFulcrum;

beforeAll(async () => {
  fulcrum = await startFakeFulcrum(loadFulcrumFixture(fixture('fulcrum/short-chains.json')));
});

afterAll(async () => {
  await fulcrum.close();
});

afterEach(() => {
  fulcrum.behaviour = () => ({ kind: 'answer' });
  fulcrum.requests.length = 0;
  cleanupScratch();
});

async function resolve(extra: string[] = [], behaviour?: FakeFulcrum['behaviour']) {
  if (behaviour) fulcrum.behaviour = behaviour;
  const dir = scratchDir();
  const authheadFile = join(dir, 'authhead.json');
  const result = await runCli(
    ['--authchain-resolve', '--resolve-via', 'fulcrum', '--chaingraph-result-file', inputFixture, '--authhead-file', authheadFile, '--json-folder', dir, ...extra],
    { cwd: dir, fulcrumUrl: fulcrum.url }
  );
  return { ...result, dir, authheadFile };
}

describe('--authchain-resolve with a fake Fulcrum', () => {
  test('resolves every announcement and writes authhead.json', async () => {
    const { stdout, authheadFile } = await resolve();

    expect(stdout).toContain('Resolution backend: fulcrum');
    expect(stdout).toContain('Authchain resolution complete');
    expect(stdout).toContain('Excluded 0 unresolved');
    expect(existsSync(authheadFile)).toBe(true);

    const authhead = JSON.parse(readFileSync(authheadFile, 'utf-8'));
    expect(Array.isArray(authhead)).toBe(true);
    expect(authhead.length).toBeGreaterThan(0);
    expect(authhead.length).toBeLessThanOrEqual(announcementCount);
    expect(stdout).toContain(`Found ${announcementCount} BCMR announcements`);

    // One entry per identity, each with a distinct authhead and a real tokenId
    expect(new Set(authhead.map((r: any) => r.authhead)).size).toBe(authhead.length);
    for (const entry of authhead) {
      expect(entry.tokenId).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.authbase).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.authhead).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof entry.hash).toBe('string');
      expect(Array.isArray(entry.uris)).toBe(true);
      expect(entry.uris.length).toBeGreaterThan(0);
      expect(typeof entry.isActive).toBe('boolean');
      expect(typeof entry.isBurned).toBe('boolean');
      expect(entry.isActive || entry.isBurned).toBe(true);
      expect(entry.authchainLength).toBeGreaterThanOrEqual(1);
    }

    // The spend fast path was used: no history walk for unspent outputs
    const methods = new Set(fulcrum.requests.map((r) => r.method));
    expect(methods).toContain('blockchain.scripthash.listunspent');
    expect(fulcrum.requests.filter((r) => r.method === 'blockchain.scripthash.listunspent').every((r) => r.params[1] === 'include_tokens')).toBe(true);
  });

  test('is deterministic: two runs produce identical authhead.json', async () => {
    const first = await resolve();
    const second = await resolve();
    expect(readFileSync(second.authheadFile, 'utf-8')).toBe(readFileSync(first.authheadFile, 'utf-8'));
  });

  test('an RPC error mid-walk leaves that announcement unresolved and uncached, the run completes', async () => {
    // Fail every history lookup: walks that need one cannot find their spender
    const { stdout, stderr, dir } = await resolve([], (method) =>
      method === 'blockchain.scripthash.get_history' ? { kind: 'error', message: 'history unavailable' } : { kind: 'answer' }
    );

    expect(stdout).toContain('Authchain resolution complete');
    expect(stdout).toMatch(/Excluded [1-9]\d* unresolved \((\d+) Fulcrum errors/);
    expect(stderr).toContain('could not be resolved because of Fulcrum errors'); // warnings go to stderr

    const cache = JSON.parse(readFileSync(join(dir, '.authchain-cache.json'), 'utf-8'));
    const unresolved = Number(stdout.match(/Excluded (\d+) unresolved/)![1]);
    // Failed walks are not cached: entries + at least the failed ones < announcements
    expect(Object.keys(cache.entries).length).toBeLessThanOrEqual(announcementCount - unresolved);
  });

  test('a socket dropped mid-request is retried and the run still completes', async () => {
    let drops = 0;
    const { stdout } = await resolve([], (method) => {
      if (method === 'blockchain.transaction.get' && drops < 3) {
        drops++;
        return { kind: 'drop' };
      }
      return { kind: 'answer' };
    });
    expect(drops).toBe(3);
    expect(stdout).toContain('Authchain resolution complete');
    expect(stdout).toContain('Excluded 0 unresolved');
    expect(stdout).toMatch(/Fulcrum dropped requests: [1-9]/);
  });

  test('an unanswered request times out instead of hanging the run', async () => {
    const dir = scratchDir();
    fulcrum.behaviour = (method, params) =>
      method === 'blockchain.transaction.get' && fulcrum.requests.filter((r) => r.method === method).length === 1
        ? { kind: 'ignore' }
        : { kind: 'answer' };
    const { stdout } = await runCli(
      ['--authchain-resolve', '--resolve-via', 'fulcrum', '--chaingraph-result-file', inputFixture, '--authhead-file', join(dir, 'authhead.json'), '--json-folder', dir],
      { cwd: dir, fulcrumUrl: fulcrum.url, extraEnv: { FULCRUM_REQUEST_TIMEOUT_MS: '500' } }
    );
    expect(stdout).toContain('Authchain resolution complete');
    expect(stdout).toMatch(/Fulcrum timeouts: [1-9]/);
  });
});
