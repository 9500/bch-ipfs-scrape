/**
 * Schema validator: bundled schema, one-time override fetch, remembered
 * failure, and the "unavailable" result.
 */
import { test, expect, describe, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { validateBCMRSchema, configureSchemaValidator, getSchemaValidator } from '../../src/lib/schema-validator.js';

const validRegistry = {
  $schema: 'https://cashtokens.org/bcmr-v2.schema.json',
  version: { major: 2, minor: 0, patch: 0 },
  latestRevision: '2024-01-01T00:00:00.000Z',
  registryIdentity: { name: 'Test registry' },
  identities: {},
};

let server: Server | null = null;

async function startSchemaServer(handler: (count: number) => { status: number; body: string }): Promise<{ url: string; hits: () => number }> {
  let count = 0;
  server = createServer((_req, res) => {
    count++;
    const reply = handler(count);
    res.writeHead(reply.status, { 'Content-Type': 'application/json' });
    res.end(reply.body);
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}/schema.json`, hits: () => count };
}

afterEach(async () => {
  configureSchemaValidator({});
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

describe('bundled schema', () => {
  test('validates without any network access', async () => {
    configureSchemaValidator({ overrideUrl: null });
    await expect(validateBCMRSchema(validRegistry)).resolves.toEqual({ isValid: true, errors: [] });

    const result = await validateBCMRSchema({ identities: 'not an object' });
    expect(result.isValid).toBe(false);
    expect(result.unavailable).toBeUndefined();
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test('concurrent validations share one validator build', async () => {
    configureSchemaValidator({ overrideUrl: null });
    const builds = await Promise.all([getSchemaValidator(), getSchemaValidator(), getSchemaValidator()]);
    expect(builds[0]).toBe(builds[1]);
    expect(builds[1]).toBe(builds[2]);
  });
});

describe('override schema (BCMR_SCHEMA_URL)', () => {
  test('is fetched once and shared by concurrent callers', async () => {
    // A permissive override schema: anything is valid, so its use is observable
    const { url, hits } = await startSchemaServer(() => ({ status: 200, body: JSON.stringify({ type: 'object' }) }));
    configureSchemaValidator({ overrideUrl: url });

    const results = await Promise.all([validateBCMRSchema({ identities: 'x' }), validateBCMRSchema({ identities: 'y' }), validateBCMRSchema({})]);
    expect(results.every((r) => r.isValid)).toBe(true);
    expect(hits()).toBe(1);
  });

  test('a failing override is tried once, then the bundled schema is used for the session', async () => {
    const { url, hits } = await startSchemaServer(() => ({ status: 500, body: 'boom' }));
    configureSchemaValidator({ overrideUrl: url, timeoutMs: 1000 });

    const first = await validateBCMRSchema(validRegistry);
    const second = await validateBCMRSchema({ identities: 'not an object' });
    const third = await validateBCMRSchema(validRegistry);

    expect(first).toEqual({ isValid: true, errors: [] });
    expect(second.isValid).toBe(false);
    expect(second.unavailable).toBeUndefined();
    expect(third.isValid).toBe(true);
    expect(hits()).toBe(1); // not re-fetched per registry
  });

  test('an unreachable override falls back to the bundled schema', async () => {
    configureSchemaValidator({ overrideUrl: 'http://127.0.0.1:1/schema.json', timeoutMs: 1000 });
    await expect(validateBCMRSchema(validRegistry)).resolves.toEqual({ isValid: true, errors: [] });
  });
});

describe('validator unavailable', () => {
  test('a schema that cannot be compiled yields an unavailable result, not a verdict', async () => {
    configureSchemaValidator({ overrideUrl: null, schema: { type: 'no-such-type' } });

    const result = await validateBCMRSchema(validRegistry);
    expect(result.unavailable).toBe(true);
    expect(result.isValid).toBe(false);
    expect(result.errors).toEqual([]);
    expect(result.reason).toBeTruthy();

    // The failure is remembered: no rebuild per call
    const again = await validateBCMRSchema(validRegistry);
    expect(again.unavailable).toBe(true);
  });
});
