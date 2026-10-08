/**
 * fetchAndValidateRegistry against a local HTTP "gateway":
 * mirrors serving wrong bytes, and validation being unavailable.
 */
import { test, expect, describe, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { fetchAndValidateRegistry, type GatewayConfig } from '../../src/lib/bcmr.js';
import { configureSchemaValidator } from '../../src/lib/schema-validator.js';

const good = JSON.stringify({
  $schema: 'https://cashtokens.org/bcmr-v2.schema.json',
  version: { major: 2, minor: 0, patch: 0 },
  latestRevision: '2024-01-01T00:00:00.000Z',
  registryIdentity: { name: 'Test registry' },
  identities: {},
});
const goodHash = createHash('sha256').update(good).digest('hex');
const tampered = good.replace('Test registry', 'Tampered registry');

let server: http.Server;
let config: GatewayConfig;
const hits: Record<string, number> = {};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = req.url || '/';
    hits[path] = (hits[path] || 0) + 1;
    if (path.includes('/wrong')) { res.writeHead(200); res.end(tampered); return; }
    if (path.includes('/down')) { res.writeHead(503); res.end('down'); return; }
    res.writeHead(200); res.end(good);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  // A plain-HTTP user gateway: ipfs:// URIs resolve to http://<host>/ipfs/<cid>[/path]
  config = { defaultGateway: `http://${host}`, rewriteAllGateways: false, targetGateway: null, gatewayMapping: null };
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  for (const key of Object.keys(hits)) delete hits[key];
  configureSchemaValidator({});
});

const cid = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';

describe('hash mismatch handling', () => {
  test('a mirror serving the wrong bytes is skipped and the next URI is used', async () => {
    const result = await fetchAndValidateRegistry([`ipfs://${cid}/wrong`, `ipfs://${cid}/right`], goodHash, 2, 2000, false, null, false, config);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.hashVerified).toBe(true);
      expect(result.rawContent).toBe(good);
    }
    // The wrong mirror is not retried, the right one answered once
    expect(hits[`/ipfs/${cid}/wrong`]).toBe(1);
    expect(hits[`/ipfs/${cid}/right`]).toBe(1);
  });

  test('fails only after every URI served the wrong bytes', async () => {
    const result = await fetchAndValidateRegistry([`ipfs://${cid}/wrong`, `ipfs://${cid}/wrong2`], goodHash, 2, 2000, false, null, false, config);
    expect(result).toEqual({ success: false, schemaInvalid: false });
    expect(hits[`/ipfs/${cid}/wrong`]).toBe(1);
    expect(hits[`/ipfs/${cid}/wrong2`]).toBe(1);
  });

  test('a mirror that errors is retried, a mirror with wrong bytes is not', async () => {
    const result = await fetchAndValidateRegistry([`ipfs://${cid}/down`, `ipfs://${cid}/wrong`, `ipfs://${cid}/right`], goodHash, 2, 2000, false, null, false, config);
    expect(result.success).toBe(true);
    expect(hits[`/ipfs/${cid}/down`]).toBe(2);
    expect(hits[`/ipfs/${cid}/wrong`]).toBe(1);
    expect(hits[`/ipfs/${cid}/right`]).toBe(1);
  });
});

describe('schema validation outcomes', () => {
  test('validated content reports schemaValidated', async () => {
    configureSchemaValidator({ overrideUrl: null });
    const result = await fetchAndValidateRegistry([`ipfs://${cid}/right`], goodHash, 2, 2000, true, null, false, config);
    expect(result.success).toBe(true);
    if (result.success) expect(result.schemaValidated).toBe(true);
  });

  test('when no validator is available the content is stored but not marked validated', async () => {
    configureSchemaValidator({ overrideUrl: null, schema: { type: 'no-such-type' } });
    const result = await fetchAndValidateRegistry([`ipfs://${cid}/right`], goodHash, 2, 2000, true, null, false, config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.schemaValidated).toBe(false);
      expect(result.hashVerified).toBe(true);
    }
  });

  test('schema-invalid content is reported with its errors', async () => {
    configureSchemaValidator({ overrideUrl: null, schema: { type: 'object', required: ['nope'] } });
    const result = await fetchAndValidateRegistry([`ipfs://${cid}/right`], goodHash, 2, 2000, true, null, false, config);
    expect(result).toMatchObject({ success: false, schemaInvalid: true, computedHash: goodHash });
    if (!result.success && result.schemaInvalid) expect(result.validationErrors.length).toBeGreaterThan(0);
  });
});
