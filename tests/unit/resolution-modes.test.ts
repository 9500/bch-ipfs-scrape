/**
 * Resolution source tiers: embedded snapshot only, snapshot seeding a live
 * backend, server-side escalation for long chains, fallback, and selection.
 */
import { test, expect, describe } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  getBCMRRegistries,
  chooseResolutionBackend,
  withFallback,
  hasEmbeddedResolution,
  type AuthchainBackend,
} from '../../src/lib/bcmr.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, '..', 'fixtures', 'chaingraph', 'three-tx-chain.json');

const txA = 'aa'.repeat(32);
const txB = 'bb'.repeat(32);
const txC = 'cc'.repeat(32);
const categoryId = 'ee'.repeat(32);
const bytea = (h: string) => '\\x' + h;

/** The A -> B -> C fixture with Chaingraph resolution embedded in every row */
function embeddedFixture() {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8'));
  const lengths: Record<string, number> = { [txA]: 3, [txB]: 2, [txC]: 1 };
  const parents: Record<string, string> = { [txA]: categoryId, [txB]: txA, [txC]: txB };
  for (const row of fixture.data.search_output_prefix) {
    const h = row.transaction_hash.slice(2);
    row.transaction.authchains = [{ authhead_transaction_hash: bytea(txC), authchain_length: String(lengths[h]), unspent_authhead: true }];
    row.transaction.inputs = [{ outpoint_transaction_hash: bytea(parents[h]), outpoint_index: '0' }];
  }
  fixture.meta = { generatedAt: '2026-10-01T00:00:00.000Z', embeddedResolution: true };
  return fixture;
}

function countingBackend(spends: Record<string, string | null>, parents: Record<string, string>, resolveChain?: AuthchainBackend['resolveChain']) {
  const spendCalls: string[] = [];
  const parentCalls: string[] = [];
  const chainCalls: string[] = [];
  const backend: AuthchainBackend = {
    name: 'fake',
    async getSpendingTx(txid) {
      spendCalls.push(txid);
      if (!(txid in spends)) throw new Error(`unexpected spend lookup for ${txid}`);
      return spends[txid];
    },
    async getParentTxId(txid) {
      parentCalls.push(txid);
      if (!(txid in parents)) throw new Error(`unexpected parent lookup for ${txid}`);
      return parents[txid];
    },
    resolveChain: resolveChain
      ? async (txid) => {
          chainCalls.push(txid);
          return resolveChain(txid);
        }
      : undefined,
  };
  return { backend, spendCalls, parentCalls, chainCalls };
}

describe('snapshot-only resolution (no backend)', () => {
  test('resolves identities from embedded data without any lookup', async () => {
    const fixture = embeddedFixture();
    expect(hasEmbeddedResolution(fixture)).toBe(true);

    const registries = await getBCMRRegistries({ useCache: false, chaingraphData: fixture, backend: null });

    const current = registries.filter((r) => !r.isSuperseded);
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({
      authbase: txA,
      authhead: txC,
      tokenId: categoryId,
      hash: '33'.repeat(32),
      authchainLength: 3,
      isAuthheadUnspent: true,
      resolutionError: null,
    });
  });

  test('an announcement without embedded data is reported as unresolved', async () => {
    const fixture = embeddedFixture();
    delete fixture.data.search_output_prefix[1].transaction.authchains; // row for C

    const registries = await getBCMRRegistries({ useCache: false, chaingraphData: fixture, backend: null });

    const c = registries.find((r) => r.hash === '33'.repeat(32));
    expect(c?.resolutionError).toMatch(/No embedded resolution data/);
    expect(c?.isAuthheadUnspent).toBe(false);
    // A and B still form their identity; its current member is B
    const current = registries.filter((r) => !r.isSuperseded && !r.resolutionError);
    expect(current.map((r) => r.hash)).toEqual(['22'.repeat(32)]);
  });

  test('plain fixture has no embedded data and cannot be resolved without a backend', async () => {
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8'));
    expect(hasEmbeddedResolution(fixture)).toBe(false);
    const registries = await getBCMRRegistries({ useCache: false, chaingraphData: fixture, backend: null });
    expect(registries.every((r) => r.resolutionError)).toBe(true);
  });
});

describe('snapshot seeding a live backend', () => {
  test('each announcement costs one "still unspent" lookup and no parent lookup', async () => {
    const { backend, spendCalls, parentCalls } = countingBackend({ [txC]: null }, {});

    const registries = await getBCMRRegistries({ useCache: false, chaingraphData: embeddedFixture(), backend });

    expect(registries.filter((r) => !r.isSuperseded)).toHaveLength(1);
    // All three snapshot entries point at C; memoised, so C is checked once
    expect(spendCalls).toEqual([txC]);
    expect(parentCalls).toEqual([]);
  });

  test('a moved authhead is walked on from the snapshot head', async () => {
    const txD = 'dd'.repeat(32);
    const { backend, spendCalls } = countingBackend({ [txC]: txD, [txD]: null }, {});

    const registries = await getBCMRRegistries({ useCache: false, chaingraphData: embeddedFixture(), backend });

    const current = registries.find((r) => !r.isSuperseded);
    expect(current).toMatchObject({ authbase: txA, authhead: txD, authchainLength: 4, hash: '33'.repeat(32) });
    expect(spendCalls.sort()).toEqual([txC, txD]);
  });

  test('a seed thousands of hops along still costs one lookup (the hop cap is per run)', async () => {
    const fixture = embeddedFixture();
    for (const row of fixture.data.search_output_prefix) {
      row.transaction.authchains[0].authchain_length = String(Number(row.transaction.authchains[0].authchain_length) + 4000);
    }
    const { backend, spendCalls } = countingBackend({ [txC]: null }, {});

    const registries = await getBCMRRegistries({ useCache: false, chaingraphData: fixture, backend });

    const current = registries.find((r) => !r.isSuperseded);
    expect(current).toMatchObject({ authhead: txC, authchainLength: 4003, isAuthheadUnspent: true, resolutionError: null });
    expect(spendCalls).toEqual([txC]);
  });

  test('--ignore-embedded walks the whole chain', async () => {
    const { backend, spendCalls, parentCalls } = countingBackend({ [txA]: txB, [txB]: txC, [txC]: null }, { [txA]: categoryId });

    await getBCMRRegistries({ useCache: false, chaingraphData: embeddedFixture(), backend, useSnapshot: false });

    expect(spendCalls.sort()).toEqual([txA, txB, txC]);
    expect(parentCalls).toEqual([txA]);
  });
});

describe('server-side escalation for long chains', () => {
  test('a long walk hands over to resolveChain after the configured hops', async () => {
    // A -> h1 -> h2 -> ... -> h40 (unspent). Only A carries a BCMR output.
    const hop = (i: number) => i.toString(16).padStart(64, '0');
    const spends: Record<string, string | null> = { [txA]: hop(1) };
    for (let i = 1; i < 40; i++) spends[hop(i)] = hop(i + 1);
    spends[hop(40)] = null;

    const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8'));
    fixture.data.search_output_prefix = fixture.data.search_output_prefix.filter((o: any) => o.transaction_hash.endsWith(txA));

    const { backend, spendCalls, chainCalls } = countingBackend(spends, { [txA]: categoryId }, async (txid) => {
      // Server resolves from txid to the end: hop(k) -> hop(40) is 40 - k + 1 long
      const k = parseInt(txid, 16);
      return { authhead: hop(40), chainLength: 40 - k + 1, isActive: true };
    });

    const registries = await getBCMRRegistries({ useCache: false, chaingraphData: fixture, backend, escalateAfterHops: 10 });

    expect(registries[0]).toMatchObject({ authbase: txA, authhead: hop(40), authchainLength: 41, isAuthheadUnspent: true });
    expect(spendCalls).toHaveLength(10); // A and hops 1..9
    expect(chainCalls).toEqual([hop(10)]);
  });
});

describe('withFallback', () => {
  test('uses the secondary backend when the primary fails', async () => {
    const primary: AuthchainBackend = {
      name: 'primary',
      getSpendingTx: async () => { throw new Error('down'); },
      getParentTxId: async () => 'p',
    };
    const secondary: AuthchainBackend = { name: 'secondary', getSpendingTx: async () => null, getParentTxId: async () => 's' };
    const backend = withFallback(primary, secondary);

    await expect(backend.getSpendingTx(txA)).resolves.toBeNull();
    await expect(backend.getParentTxId(txA)).resolves.toBe('p');
    expect(backend.getStats!()['Lookups that fell back']).toBe(1);
  });
});

describe('chooseResolutionBackend', () => {
  test('auto prefers Chaingraph, then Fulcrum, then the snapshot', () => {
    expect(chooseResolutionBackend('auto', false, { CHAINGRAPH_URL: 'http://cg', FULCRUM_WS_URL: 'ws://f' })!.name).toMatch(/^chaingraph .* with fallback to fulcrum/);
    expect(chooseResolutionBackend('auto', false, { CHAINGRAPH_URL: 'http://cg' })!.name).toMatch(/^chaingraph/);
    expect(chooseResolutionBackend('auto', false, { FULCRUM_WS_URL: 'ws://f' })!.name).toMatch(/^fulcrum/);
    expect(chooseResolutionBackend('auto', true, {})).toBeNull();
    expect(() => chooseResolutionBackend('auto', false, {})).toThrow(/No resolution source/);
  });

  test('explicit sources are validated', () => {
    expect(chooseResolutionBackend('file', true, { CHAINGRAPH_URL: 'http://cg' })).toBeNull();
    expect(() => chooseResolutionBackend('file', false, {})).toThrow(/no embedded resolution data/);
    expect(() => chooseResolutionBackend('chaingraph', true, {})).toThrow(/CHAINGRAPH_URL/);
    expect(() => chooseResolutionBackend('fulcrum', true, {})).toThrow(/FULCRUM_WS_URL/);
    expect(chooseResolutionBackend('fulcrum', true, { FULCRUM_WS_URL: 'ws://f', CHAINGRAPH_URL: 'http://cg' })!.name).toMatch(/^fulcrum/);
  });
});
