/**
 * Opt-in smoke test against the real Chaingraph and Fulcrum servers from .env.
 *
 *   LIVE_TESTS=1 npx vitest run tests/integration/live-smoke.test.ts
 *
 * Everything else in the suite runs against local fakes. This is the one place
 * that checks the real servers still speak the protocol the fakes imitate.
 */
import { test, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import dotenv from 'dotenv';
import { runCli, fixture, scratchDir, cleanupScratch, projectRoot } from '../helpers/cli.js';

dotenv.config({ path: join(projectRoot, '.env') });

const live = process.env.LIVE_TESTS === '1';
const chaingraphUrl = process.env.CHAINGRAPH_URL;
const fulcrumUrl = process.env.FULCRUM_WS_URL;

afterEach(() => cleanupScratch());

test('live Fulcrum resolves the short-chain fixture', { skip: !live || !fulcrumUrl, timeout: 120000 }, async () => {
  const dir = scratchDir();
  const { stdout } = await runCli(
    ['--authchain-resolve', '--resolve-via', 'fulcrum', '--chaingraph-result-file', fixture('chaingraph/short-chains-half.json'), '--authhead-file', join(dir, 'authhead.json'), '--json-folder', dir, '--concurrency', '5'],
    { cwd: dir, fulcrumUrl, timeoutMs: 110000 }
  );
  expect(stdout).toContain('Authchain resolution complete');
  expect(stdout).toContain('Excluded 0 unresolved');
  expect(JSON.parse(readFileSync(join(dir, 'authhead.json'), 'utf-8')).length).toBeGreaterThan(0);
});

test('live Chaingraph answers the paged default query and resolves chains', { skip: !live || !chaingraphUrl, timeout: 300000 }, async () => {
  const dir = scratchDir();
  const out = join(dir, 'chaingraph-result.json');
  const query = await runCli(['--query-chaingraph', '--no-embed-resolution', '--chaingraph-result-file', out], { cwd: dir, chaingraphUrl, timeoutMs: 280000 });
  expect(query.stdout).toMatch(/Found \d{4,} BCMR outputs/);

  const resolve = await runCli(
    ['--authchain-resolve', '--resolve-via', 'chaingraph', '--chaingraph-result-file', fixture('chaingraph/short-chains-half.json'), '--authhead-file', join(dir, 'authhead.json'), '--json-folder', dir],
    { cwd: dir, chaingraphUrl, timeoutMs: 280000 }
  );
  expect(resolve.stdout).toContain('Resolution backend: chaingraph');
  expect(resolve.stdout).toContain('Excluded 0 unresolved');
});

if (!live) {
  console.log('\n  Live smoke tests skipped (set LIVE_TESTS=1 and configure .env to run them)\n');
}
