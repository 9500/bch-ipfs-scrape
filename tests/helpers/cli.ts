/**
 * Run the built CLI (dist/index.js) as a child process.
 *
 * The CLI loads `.env` from its working directory, and dotenv never overrides
 * variables already present in the environment. Tests therefore run the CLI in
 * a scratch directory and pass endpoints explicitly, so a developer's .env can
 * never leak live servers into a test.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

export const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const cliPath = join(projectRoot, 'dist', 'index.js');
export const fixture = (relative: string): string => join(projectRoot, 'tests', 'fixtures', relative);

export interface CliResult {
  stdout: string;
  stderr: string;
}

export interface CliOptions {
  /** Working directory (default: a fresh scratch directory) */
  cwd?: string;
  /** Endpoints to expose to the CLI; unset ones are removed from the environment */
  fulcrumUrl?: string;
  chaingraphUrl?: string;
  extraEnv?: Record<string, string>;
  /** Kill the child after this many ms (default 60000) */
  timeoutMs?: number;
}

export async function runCli(args: string[], options: CliOptions = {}): Promise<CliResult> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.CHAINGRAPH_URL;
  delete env.FULCRUM_WS_URL;
  if (options.fulcrumUrl) env.FULCRUM_WS_URL = options.fulcrumUrl;
  if (options.chaingraphUrl) env.CHAINGRAPH_URL = options.chaingraphUrl;
  Object.assign(env, options.extraEnv);

  const { stdout, stderr } = await execFileAsync('node', [cliPath, ...args], {
    env,
    cwd: options.cwd ?? scratchDir(),
    maxBuffer: 50 * 1024 * 1024,
    timeout: options.timeoutMs ?? 60000, // the child is killed on timeout, never orphaned
  });
  return { stdout, stderr };
}

const scratchDirs: string[] = [];

/** A fresh temporary directory, removed by cleanupScratch() */
export function scratchDir(prefix = 'bch-ipfs-scrape-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

export function cleanupScratch(): void {
  for (const dir of scratchDirs.splice(0)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
}
