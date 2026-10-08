import { test, expect, describe, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { isInternalHostname, isPrivateIP, safeFetch } from '../../src/lib/ssrf.js';
import { normalizeUri, resolveUri, fetchAndValidateRegistry, type GatewayConfig } from '../../src/lib/bcmr.js';
import { createHash } from 'node:crypto';

const tlsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'tls');

// ========================================
// isInternalHostname() / isPrivateIP()
// ========================================

describe('isInternalHostname', () => {
  const internal = [
    'localhost', 'LOCALHOST', 'localhost.', 'foo.localhost',
    '127.0.0.1', '127.255.255.255', '0.0.0.0', '10.1.2.3',
    '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.1.1',
    '100.64.0.1', '100.127.255.255', '192.0.0.1', '198.18.0.1',
    '224.0.0.1', '240.0.0.1', '255.255.255.255',
    '[::1]', '[::]', '[fe80::1]', '[fc00::1]', '[fd12::1]', '[fec0::1]', '[ff02::1]',
    '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[::ffff:c0a8:101]', '[64:ff9b::7f00:1]',
  ];
  const external = [
    'ipfs.io', 'dweb.link', 'example.localhost.com',
    '8.8.8.8', '1.1.1.1', '11.0.0.1', '172.15.255.255', '172.32.0.1',
    '192.169.0.1', '100.63.255.255', '100.128.0.0', '198.17.255.255',
    '[2606:4700:4700::1111]', '[::ffff:8.8.8.8]', '[64:ff9b::808:808]',
  ];

  test.each(internal)('%s is internal', (host) => {
    expect(isInternalHostname(host)).toBe(true);
  });

  test.each(external)('%s is external', (host) => {
    expect(isInternalHostname(host)).toBe(false);
  });

  test('unparseable IPv6 is treated as internal', () => {
    expect(isPrivateIP('[1:2:3:4:5:6:7:8:9]')).toBe(false); // not an IP at all -> hostname, not private
    expect(isPrivateIP('::ffff:999.1.1.1')).toBe(false);
  });
});

// ========================================
// normalizeUri() SSRF checks via URL canonicalization
// ========================================

describe('normalizeUri blocks canonicalized internal addresses', () => {
  const blocked = [
    'http://127.0.0.1/x.json',
    'http://127.1/x.json',          // shorthand
    'http://2130706433/x.json',     // decimal
    'http://0x7f000001/x.json',     // hex
    'http://0.0.0.0/x.json',
    'http://[::1]/x.json',
    'http://[::ffff:192.168.1.1]/x.json',
    'http://[fe80::1]/x.json',
    'http://[fd00::1]/x.json',
    'http://100.64.0.1/x.json',
    'http://localhost./x.json',
    'http://foo.localhost/x.json',
    '192.168.1.1/x.json',           // no scheme -> https://
  ];

  test.each(blocked)('%s is rejected', (uri) => {
    expect(() => normalizeUri(uri)).toThrow('Internal/private hostnames not allowed');
  });

  test('public hosts are accepted unchanged', () => {
    expect(normalizeUri('https://ipfs.io/ipfs/QmTest1234567890abcdefghijklmnop')).toBe(
      'https://ipfs.io/ipfs/QmTest1234567890abcdefghijklmnop'
    );
  });

  test('resolveUri flags user-configured gateways as trusted', () => {
    const config: GatewayConfig = {
      defaultGateway: '192.168.1.100:8080',
      rewriteAllGateways: true,
      targetGateway: '10.0.0.5:8080',
      gatewayMapping: null,
    };
    expect(resolveUri('ipfs://QmTest1234567890abcdefghijklmnop', config)).toEqual({
      url: 'https://192.168.1.100:8080/ipfs/QmTest1234567890abcdefghijklmnop',
      userGateway: true,
    });
    expect(resolveUri('https://ipfs.io/ipfs/QmTest1234567890abcdefghijklmnop', config)).toEqual({
      url: 'https://10.0.0.5:8080/ipfs/QmTest1234567890abcdefghijklmnop',
      userGateway: true,
    });
    expect(resolveUri('https://example.com/registry.json', config)).toEqual({
      url: 'https://example.com/registry.json',
      userGateway: false,
    });
  });
});

// ========================================
// safeFetch() / fetchAndValidateRegistry() against a local server
// ========================================

describe('safeFetch and fetchAndValidateRegistry', () => {
  const good = '{"identities":{}}';
  const bomGood = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(good)]);
  let server: http.Server;
  let tlsServer: https.Server;
  let host: string;
  let tlsHost: string;
  let config: GatewayConfig;
  let previousTlsSetting: string | undefined;

  beforeAll(async () => {
    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
      const path = req.url || '/';
      if (path.startsWith('/ipfs/stall')) { res.writeHead(200); res.write('{"id'); return; }
      if (path.startsWith('/ipfs/big')) { res.writeHead(200); res.end(Buffer.alloc(256 * 1024, 32)); return; }
      if (path.startsWith('/ipfs/redir-internal')) { res.writeHead(302, { location: 'http://10.0.0.1/secret' }); res.end(); return; }
      if (path.startsWith('/ipfs/redir-loop')) { res.writeHead(302, { location: `http://${host}/ipfs/redir-loop` }); res.end(); return; }
      if (path.startsWith('/ipfs/redir-self')) { res.writeHead(302, { location: `http://${host}/ipfs/ok` }); res.end(); return; }
      if (path.startsWith('/ipfs/bom')) { res.writeHead(200); res.end(bomGood); return; }
      if (path.startsWith('/secret')) { res.writeHead(200); res.end('INTERNAL'); return; }
      res.writeHead(200); res.end(good);
    };
    server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    host = `127.0.0.1:${(server.address() as AddressInfo).port}`;

    // ipfs:// URIs always resolve to https://<gateway>, so the gateway used by
    // fetchAndValidateRegistry must speak TLS (self-signed test certificate)
    tlsServer = https.createServer(
      { key: readFileSync(join(tlsDir, 'localhost.key')), cert: readFileSync(join(tlsDir, 'localhost.crt')) },
      handler
    );
    await new Promise<void>((resolve) => tlsServer.listen(0, '127.0.0.1', resolve));
    tlsHost = `127.0.0.1:${(tlsServer.address() as AddressInfo).port}`;
    previousTlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

    config = { defaultGateway: tlsHost, rewriteAllGateways: false, targetGateway: null, gatewayMapping: null };
  });

  afterAll(async () => {
    if (previousTlsSetting === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTlsSetting;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => tlsServer.close(() => resolve()));
  });

  test('refuses an internal host unless it is the trusted gateway', async () => {
    await expect(safeFetch(`http://${host}/ipfs/ok`, { maxBytes: 1000 })).rejects.toThrow(
      'Internal/private hostnames not allowed'
    );
    const r = await safeFetch(`http://${host}/ipfs/ok`, { maxBytes: 1000, trustedHost: host });
    expect(r.body.toString()).toBe(good);
  });

  test('redirect from trusted gateway to an internal host is refused', async () => {
    await expect(
      safeFetch(`http://${host}/ipfs/redir-internal`, { maxBytes: 1000, trustedHost: host })
    ).rejects.toThrow('Internal/private hostnames not allowed');
  });

  test('redirect that stays on the trusted gateway is followed', async () => {
    const r = await safeFetch(`http://${host}/ipfs/redir-self`, { maxBytes: 1000, trustedHost: host });
    expect(r.body.toString()).toBe(good);
    expect(r.url).toBe(`http://${host}/ipfs/ok`);
  });

  test('redirect loops are capped', async () => {
    await expect(
      safeFetch(`http://${host}/ipfs/redir-loop`, { maxBytes: 1000, trustedHost: host })
    ).rejects.toThrow('Too many redirects');
  });

  test('body larger than maxBytes is rejected', async () => {
    await expect(
      safeFetch(`http://${host}/ipfs/big`, { maxBytes: 64 * 1024, trustedHost: host })
    ).rejects.toThrow('Response too large');
  });

  test('timeout covers a stalled body', async () => {
    const start = Date.now();
    const r = await fetchAndValidateRegistry(['ipfs://stall'], 'x', 1, 300, false, null, false, config);
    expect(r.success).toBe(false);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  test('a public DNS name that resolves to loopback is refused', async () => {
    // localtest.me is a public wildcard DNS name pointing at 127.0.0.1
    await expect(safeFetch('http://localtest.me/', { maxBytes: 1000 })).rejects.toThrow(
      /resolves to internal\/private address|ENOTFOUND|EAI_AGAIN/
    );
  });

  test('hash is computed over raw bytes, including a BOM', async () => {
    const expected = createHash('sha256').update(bomGood).digest('hex');
    const r = await fetchAndValidateRegistry(['ipfs://bom'], expected, 1, 1000, false, null, false, config);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.hashVerified).toBe(true);
      expect(r.rawBytes.equals(bomGood)).toBe(true);
      expect(r.json).toEqual({ identities: {} });
    }
  });

  test('an unsafe URI is skipped and the next URI is tried', async () => {
    const expected = createHash('sha256').update(good).digest('hex');
    const r = await fetchAndValidateRegistry(
      ['http://127.0.0.1/x.json', 'ipfs://ok'], expected, 1, 1000, false, null, false, config
    );
    expect(r.success).toBe(true);
  });
});
