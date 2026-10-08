/**
 * --authchain-resolve from a result file with embedded resolution needs no
 * Chaingraph and no Fulcrum. Runs everywhere (no environment required).
 */
import { test, expect, afterEach } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, existsSync, rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';

const execFileAsync = promisify(execFile);
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliPath = join(projectRoot, 'dist', 'index.js');
const fixture = join(projectRoot, 'tests/fixtures/chaingraph/short-chains-embedded.json');

let workDir: string | null = null;

afterEach(() => {
  if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  workDir = null;
});

test('resolves from the embedded snapshot with no endpoints configured', { timeout: 60000 }, async () => {
  workDir = mkdtempSync(join(tmpdir(), 'file-only-'));
  const authheadFile = join(workDir, 'authhead.json');
  const env = { ...process.env };
  delete env.CHAINGRAPH_URL;
  delete env.FULCRUM_WS_URL;

  const { stdout } = await execFileAsync(
    'node',
    [cliPath, '--authchain-resolve', '--chaingraph-result-file', fixture, '--authhead-file', authheadFile, '--json-folder', workDir],
    { env, cwd: workDir, maxBuffer: 50 * 1024 * 1024 }
  );

  expect(stdout).toContain('Resolving from the embedded snapshot only');
  expect(stdout).toContain('No blockchain queries were made');
  expect(stdout).toContain('Excluded 0 unresolved');

  const authhead = JSON.parse(readFileSync(authheadFile, 'utf-8'));
  expect(Array.isArray(authhead)).toBe(true);
  expect(authhead.length).toBeGreaterThan(50);
  for (const entry of authhead) {
    expect(entry.tokenId).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.authhead).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.isActive || entry.isBurned).toBe(true);
  }
});

test('--resolve-via fulcrum without FULCRUM_WS_URL fails with a clear error', { timeout: 60000 }, async () => {
  workDir = mkdtempSync(join(tmpdir(), 'file-only-'));
  const env = { ...process.env };
  delete env.CHAINGRAPH_URL;
  delete env.FULCRUM_WS_URL;

  await expect(
    execFileAsync('node', [cliPath, '--authchain-resolve', '--resolve-via', 'fulcrum', '--chaingraph-result-file', fixture, '--json-folder', workDir], { env, cwd: workDir })
  ).rejects.toMatchObject({ stderr: expect.stringContaining('requires FULCRUM_WS_URL') });
});
