import { test, expect, describe, afterEach } from 'vitest';
import { readFileSync, existsSync, rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getBCMRRegistries, type AuthchainBackend } from '../../src/lib/bcmr.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, '..', 'fixtures', 'chaingraph', 'three-tx-chain.json');

// Transaction IDs used by the fixture (tests/fixtures/chaingraph/three-tx-chain.json)
const txA = 'aa'.repeat(32); // first announcement (genesis), authbase
const txB = 'bb'.repeat(32); // second announcement
const txC = 'cc'.repeat(32); // third announcement, authhead
const txD = 'dd'.repeat(32); // a non-BCMR tx that moves the authhead (second scenario)
const categoryId = 'ee'.repeat(32); // output spent by A's input 0 = CashToken category

/**
 * Build a fake blockchain backend from an output-0 spend map and a parent map.
 * Records every call so tests can assert on query counts.
 */
function fakeBackend(spends: Record<string, string | null>, parents: Record<string, string>) {
  const spendCalls: string[] = [];
  const txCalls: string[] = [];
  const backend: AuthchainBackend = {
    async getOutputSpendingTx(txid, vout) {
      expect(vout).toBe(0);
      spendCalls.push(txid);
      if (!(txid in spends)) throw new Error(`unexpected spend lookup for ${txid}`);
      return spends[txid];
    },
    async getTransaction(txid) {
      txCalls.push(txid);
      if (!(txid in parents)) throw new Error(`unexpected tx lookup for ${txid}`);
      return { vin: [{ txid: parents[txid], vout: 0 }] };
    },
  };
  return { backend, spendCalls, txCalls };
}

function loadFixture() {
  return JSON.parse(readFileSync(fixturePath, 'utf-8'));
}

describe('getBCMRRegistries authchain grouping', () => {
  test('3-tx chain A->B->C yields one current registry carrying C', async () => {
    const { backend, spendCalls, txCalls } = fakeBackend(
      { [txA]: txB, [txB]: txC, [txC]: null },
      { [txA]: categoryId, [txB]: txA, [txC]: txB }
    );

    const registries = await getBCMRRegistries({
      useCache: false,
      chaingraphData: loadFixture(),
      backend,
    });

    // Every announcement is reported, but exactly one is current
    expect(registries).toHaveLength(3);
    const current = registries.filter((r) => !r.isSuperseded);
    const superseded = registries.filter((r) => r.isSuperseded);
    expect(current).toHaveLength(1);
    expect(superseded).toHaveLength(2);

    // The current entry is C's announcement with consistent chain fields
    expect(current[0]).toMatchObject({
      authbase: txA,
      authhead: txC,
      tokenId: categoryId,
      blockHeight: 800003,
      hash: '33'.repeat(32),
      uris: ['ipfs://bafyversion3'],
      authchainLength: 3,
      isAuthheadUnspent: true,
      isBurned: false,
      isValid: true,
      isSuperseded: false,
    });

    // Superseded entries keep their own content but share the identity fields
    expect(superseded.map((r) => r.hash).sort()).toEqual(['11'.repeat(32), '22'.repeat(32)]);
    for (const r of superseded) {
      expect(r.authbase).toBe(txA);
      expect(r.authhead).toBe(txC);
      expect(r.tokenId).toBe(categoryId);
      expect(r.authchainLength).toBe(3);
    }

    // Only C's hash/URIs are emitted among current registries
    expect(current.map((r) => r.hash)).toEqual(['33'.repeat(32)]);
    expect(current.flatMap((r) => r.uris)).toEqual(['ipfs://bafyversion3']);

    // tokenId is derived once, from the earliest announcement (A), never from B or C
    expect(txCalls).toEqual([txA]);

    // Spend lookups are memoised: each of A, B, C is queried exactly once
    expect([...spendCalls].sort()).toEqual([txA, txB, txC]);
  });

  test('authhead moved without a new announcement keeps the latest announcement current', async () => {
    // A -> B -> D, where D spends B's output 0 but carries no BCMR output
    const { backend, txCalls } = fakeBackend(
      { [txA]: txB, [txB]: txD, [txD]: null },
      { [txA]: categoryId }
    );

    const fixture = loadFixture();
    fixture.data.search_output_prefix = fixture.data.search_output_prefix.filter(
      (o: { transaction_hash: string }) => !o.transaction_hash.endsWith(txC)
    );

    const registries = await getBCMRRegistries({
      useCache: false,
      chaingraphData: fixture,
      backend,
    });

    expect(registries).toHaveLength(2);
    const current = registries.filter((r) => !r.isSuperseded);
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({
      authbase: txA,
      authhead: txD,
      tokenId: categoryId,
      hash: '22'.repeat(32),
      uris: ['ipfs://bafyversion2', 'https://example.com/v2.json'],
      authchainLength: 3,
      isAuthheadUnspent: true,
      isSuperseded: false,
    });
    expect(txCalls).toEqual([txA]);
  });

  test('independent identities are not merged', async () => {
    const other = 'ff'.repeat(32);
    const otherCategory = '99'.repeat(32);
    const fixture = loadFixture();
    // Add an unrelated single-announcement identity (OP_RETURN at output 1)
    const template = fixture.data.search_output_prefix[0];
    fixture.data.search_output_prefix.push({
      ...template,
      transaction_hash: '\\x' + other,
      transaction: { block_inclusions: [{ block: { hash: '\\x' + '00'.repeat(32), height: '800010' } }] },
    });

    const { backend, txCalls } = fakeBackend(
      { [txA]: txB, [txB]: txC, [txC]: null, [other]: null },
      { [txA]: categoryId, [other]: otherCategory }
    );

    const registries = await getBCMRRegistries({
      useCache: false,
      chaingraphData: fixture,
      backend,
    });

    const current = registries.filter((r) => !r.isSuperseded);
    expect(current.map((r) => r.authhead).sort()).toEqual([txC, other].sort());
    expect(current.find((r) => r.authhead === other)).toMatchObject({
      authbase: other,
      tokenId: otherCategory,
      authchainLength: 1,
      isSuperseded: false,
    });
    expect([...txCalls].sort()).toEqual([txA, other].sort());
  });
});

describe('getBCMRRegistries error handling', () => {
  let scratchDir: string | null = null;

  afterEach(() => {
    if (scratchDir && existsSync(scratchDir)) {
      rmSync(scratchDir, { recursive: true, force: true });
    }
    scratchDir = null;
  });

  test('a backend error mid-walk is reported as unresolved and never cached', async () => {
    scratchDir = mkdtempSync(join(tmpdir(), 'authchain-cache-'));
    const cachePath = join(scratchDir, '.authchain-cache.json');

    // A -> B, but the spend lookup for B fails. C is an unrelated healthy identity.
    const spends: Record<string, string | null> = { [txA]: txB, [txC]: null };
    const backend: AuthchainBackend = {
      async getOutputSpendingTx(txid) {
        if (txid === txB) throw new Error('Fulcrum request timed out');
        if (!(txid in spends)) throw new Error(`unexpected spend lookup for ${txid}`);
        return spends[txid];
      },
      async getTransaction(txid) {
        return { vin: [{ txid: txid === txC ? 'cc'.repeat(31) + '01' : categoryId, vout: 0 }] };
      },
    };

    const registries = await getBCMRRegistries({
      useCache: true,
      cachePath,
      chaingraphData: loadFixture(),
      backend,
    });

    // A's walk reached B and failed there; B's walk failed immediately.
    const failed = registries.filter((r) => r.resolutionError);
    expect(failed.map((r) => r.hash).sort()).toEqual(['11'.repeat(32), '22'.repeat(32)]);
    for (const r of failed) {
      expect(r.isAuthheadUnspent).toBe(false);
      expect(r.isSuperseded).toBe(false);
      expect(r.resolutionError).toMatch(/timed out/);
    }

    // The failed announcements neither joined nor superseded the healthy identity
    const healthy = registries.find((r) => r.hash === '33'.repeat(32));
    expect(healthy).toMatchObject({
      authbase: txC,
      authhead: txC,
      authchainLength: 1,
      isAuthheadUnspent: true,
      isSuperseded: false,
      resolutionError: null,
    });

    // Only the completed walk was cached
    const cache = JSON.parse(readFileSync(cachePath, 'utf-8'));
    expect(cache.version).toBe(2);
    expect(Object.keys(cache.entries)).toEqual([txC]);
  });

  test('a failed tokenId lookup skips the identity without aborting the run', async () => {
    const { backend } = fakeBackend(
      { [txA]: txB, [txB]: txC, [txC]: null },
      {} // getTransaction throws for every txid
    );

    const registries = await getBCMRRegistries({
      useCache: false,
      chaingraphData: loadFixture(),
      backend,
    });

    expect(registries).toEqual([]);
  });
});
