/**
 * --query-chaingraph against a fake Chaingraph that serves a fixture and
 * caps requests at 5000 rows like the real server.
 */
import { test, expect, describe, beforeAll, afterAll, afterEach } from 'vitest';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli, fixture, scratchDir, cleanupScratch } from '../helpers/cli.js';
import { startFakeChaingraph, type FakeChaingraph } from '../helpers/fake-chaingraph.js';

const sampleRows: unknown[] = JSON.parse(readFileSync(fixture('chaingraph/sample-200-registries.json'), 'utf-8')).data.search_output_prefix;

// 5871 rows: more than one 5000-row cap and not a multiple of the 1000-row page
const manyRows: unknown[] = Array.from({ length: 5871 }, (_, i) => ({
  ...(sampleRows[i % sampleRows.length] as object),
  transaction_hash: '\\x' + i.toString(16).padStart(64, '0'),
}));

let chaingraph: FakeChaingraph;

beforeAll(async () => {
  chaingraph = await startFakeChaingraph(manyRows, { maxRows: 5000 });
});

afterAll(async () => {
  await chaingraph.close();
});

afterEach(() => {
  chaingraph.requests.length = 0;
  cleanupScratch();
});

describe('--query-chaingraph', () => {
  test('pages through the default query and saves every row with metadata', async () => {
    const dir = scratchDir();
    const out = join(dir, 'chaingraph-result.json');

    const { stdout } = await runCli(['--query-chaingraph', '--no-embed-resolution', '--chaingraph-result-file', out], { cwd: dir, chaingraphUrl: chaingraph.url });

    expect(stdout).toContain('Found 5871 BCMR outputs');
    expect(stdout).toContain('Skipping resolution embedding');
    expect(existsSync(out)).toBe(true);

    // Six pages of 1000 (the last one short), each in a stable order
    const pages = chaingraph.requests.map((r) => r.variables?.offset);
    expect(pages).toEqual([0, 1000, 2000, 3000, 4000, 5000]);
    expect(chaingraph.requests[0].query).toContain('order_by');

    const result = JSON.parse(readFileSync(out, 'utf-8'));
    expect(result.meta.embeddedResolution).toBe(false);
    expect(typeof result.meta.generatedAt).toBe('string');
    expect(result.data.search_output_prefix).toHaveLength(5871);
    expect(new Set(result.data.search_output_prefix.map((r: any) => r.transaction_hash)).size).toBe(5871);

    const first = result.data.search_output_prefix[0];
    expect(first.transaction_hash).toMatch(/^\\x[0-9a-f]+$/i);
    expect(typeof first.locking_bytecode).toBe('string');
    expect(first.output_index).toBeDefined();
    expect(Array.isArray(first.transaction.block_inclusions)).toBe(true);
    expect(first).toHaveProperty('spent_by');
  });

  test('a custom query file is sent as-is (single request, server cap applies)', async () => {
    const dir = scratchDir();
    const out = join(dir, 'result.json');

    const { stdout } = await runCli(
      ['--query-chaingraph', fixture('chaingraph/limit-1000-query.graphql'), '--no-embed-resolution', '--chaingraph-result-file', out],
      { cwd: dir, chaingraphUrl: chaingraph.url }
    );

    expect(stdout).toContain('Custom query loaded successfully');
    expect(chaingraph.requests).toHaveLength(1);
    expect(chaingraph.requests[0].query).toContain('limit: 1000');
    const result = JSON.parse(readFileSync(out, 'utf-8'));
    expect(result.data.search_output_prefix).toHaveLength(1000);
  });

  test('a saved result can be resolved from its embedded snapshot later', async () => {
    // The producer and consumer halves meet at the file: write a file with
    // embedded data by hand (as --query-chaingraph would) and resolve it offline
    const dir = scratchDir();
    const out = join(dir, 'chaingraph-result.json');
    const embedded = JSON.parse(readFileSync(fixture('chaingraph/short-chains-embedded.json'), 'utf-8'));
    writeFileSync(out, JSON.stringify(embedded));

    const { stdout } = await runCli(['--authchain-resolve', '--chaingraph-result-file', out, '--authhead-file', join(dir, 'authhead.json'), '--json-folder', dir], { cwd: dir });
    expect(stdout).toContain('Resolving from the embedded snapshot only');
    expect(stdout).toContain('Excluded 0 unresolved');
  });

  test('fails clearly when CHAINGRAPH_URL is not set', async () => {
    const dir = scratchDir();
    await expect(runCli(['--query-chaingraph', '--chaingraph-result-file', join(dir, 'x.json')], { cwd: dir })).rejects.toMatchObject({
      stderr: expect.stringContaining('CHAINGRAPH_URL environment variable is not set'),
    });
  });
});
