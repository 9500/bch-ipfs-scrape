import { test, expect } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';

const execFileAsync = promisify(execFile);

// Get the project root directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..', '..');

// Path to the compiled CLI entry point
const cliPath = join(projectRoot, 'dist', 'index.js');

// Read expected version from package.json
const packageJson = JSON.parse(
  readFileSync(join(projectRoot, 'package.json'), 'utf-8')
);
const expectedVersion = packageJson.version;

test('--version flag displays correct version', async () => {
  // Execute the CLI with --version flag
  const { stdout, stderr } = await execFileAsync('node', [cliPath, '--version']);

  // Verify the output format matches: "bch-ipfs-scrape v{version}"
  expect(stdout.trim()).toBe(`bch-ipfs-scrape v${expectedVersion}`);

  // Verify no error output
  expect(stderr).toBe('');
});

test('--version flag exits successfully', async () => {
  // The execFileAsync will throw if exit code is non-zero
  // So if this test completes without throwing, exit code was 0
  await expect(
    execFileAsync('node', [cliPath, '--version'])
  ).resolves.toBeDefined();
});
