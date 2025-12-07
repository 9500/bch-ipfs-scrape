import { test, expect, describe, beforeEach, afterEach } from 'vitest';
import { normalizeGatewayDomain, loadGatewayMapping } from '../../src/index.js';
import { normalizeUri, type GatewayConfig } from '../../src/lib/bcmr.js';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const testFixturesDir = join(__dirname, '..', 'fixtures', 'gateway-mappings');

// Setup and teardown for test fixtures
beforeEach(() => {
  if (!existsSync(testFixturesDir)) {
    mkdirSync(testFixturesDir, { recursive: true });
  }
});

afterEach(() => {
  if (existsSync(testFixturesDir)) {
    rmSync(testFixturesDir, { recursive: true, force: true });
  }
});

// ========================================
// normalizeGatewayDomain() Tests
// ========================================

describe('normalizeGatewayDomain', () => {
  test('removes https:// prefix', () => {
    expect(normalizeGatewayDomain('https://ipfs.io')).toBe('ipfs.io');
  });

  test('removes http:// prefix', () => {
    expect(normalizeGatewayDomain('http://ipfs.io')).toBe('ipfs.io');
  });

  test('removes trailing slashes', () => {
    expect(normalizeGatewayDomain('ipfs.io/')).toBe('ipfs.io');
    expect(normalizeGatewayDomain('ipfs.io///')).toBe('ipfs.io');
  });

  test('converts to lowercase', () => {
    expect(normalizeGatewayDomain('IPFS.IO')).toBe('ipfs.io');
    expect(normalizeGatewayDomain('Gateway.Pinata.Cloud')).toBe('gateway.pinata.cloud');
  });

  test('handles all transformations together', () => {
    expect(normalizeGatewayDomain('HTTPS://IPFS.IO/')).toBe('ipfs.io');
    expect(normalizeGatewayDomain('HTTP://Gateway.Pinata.Cloud///')).toBe('gateway.pinata.cloud');
  });

  test('preserves port numbers', () => {
    expect(normalizeGatewayDomain('localhost:8080')).toBe('localhost:8080');
    expect(normalizeGatewayDomain('192.168.1.100:8080')).toBe('192.168.1.100:8080');
  });

  test('handles private IPs with ports', () => {
    expect(normalizeGatewayDomain('https://192.168.1.100:8080/')).toBe('192.168.1.100:8080');
    expect(normalizeGatewayDomain('http://localhost:9000/')).toBe('localhost:9000');
  });

  test('trims whitespace', () => {
    expect(normalizeGatewayDomain('  ipfs.io  ')).toBe('ipfs.io');
    expect(normalizeGatewayDomain('\tipfs.io\n')).toBe('ipfs.io');
  });

  test('handles already-normalized domains', () => {
    expect(normalizeGatewayDomain('ipfs.io')).toBe('ipfs.io');
    expect(normalizeGatewayDomain('gateway.pinata.cloud')).toBe('gateway.pinata.cloud');
  });
});

// ========================================
// loadGatewayMapping() Tests
// ========================================

describe('loadGatewayMapping', () => {
  test('loads valid mapping file', () => {
    const mappingFile = join(testFixturesDir, 'valid.json');
    writeFileSync(
      mappingFile,
      JSON.stringify({
        'ipfs.io': 'dweb.link',
        'cloudflare-ipfs.com': 'gateway.pinata.cloud',
      })
    );

    const mapping = loadGatewayMapping(mappingFile);
    expect(mapping.size).toBe(2);
    expect(mapping.get('ipfs.io')).toBe('dweb.link');
    expect(mapping.get('cloudflare-ipfs.com')).toBe('gateway.pinata.cloud');
  });

  test('normalizes mapping keys and values', () => {
    const mappingFile = join(testFixturesDir, 'normalized.json');
    writeFileSync(
      mappingFile,
      JSON.stringify({
        'https://IPFS.IO/': 'dweb.link',
        'CLOUDFLARE-IPFS.COM': 'https://Gateway.Pinata.Cloud/',
      })
    );

    const mapping = loadGatewayMapping(mappingFile);
    expect(mapping.get('ipfs.io')).toBe('dweb.link');
    expect(mapping.get('cloudflare-ipfs.com')).toBe('gateway.pinata.cloud');
  });

  test('supports private IPs in destinations', () => {
    const mappingFile = join(testFixturesDir, 'private-ips.json');
    writeFileSync(
      mappingFile,
      JSON.stringify({
        'ipfs.io': '192.168.1.100:8080',
        'dweb.link': 'localhost:9000',
      })
    );

    const mapping = loadGatewayMapping(mappingFile);
    expect(mapping.get('ipfs.io')).toBe('192.168.1.100:8080');
    expect(mapping.get('dweb.link')).toBe('localhost:9000');
  });

  test('throws error when file does not exist', () => {
    const nonExistentFile = join(testFixturesDir, 'nonexistent.json');
    expect(() => loadGatewayMapping(nonExistentFile)).toThrow(
      'Gateway mapping file not found'
    );
  });

  test('throws error on invalid JSON', () => {
    const invalidFile = join(testFixturesDir, 'invalid.json');
    writeFileSync(invalidFile, '{ invalid json }');

    expect(() => loadGatewayMapping(invalidFile)).toThrow('Invalid JSON');
  });

  test('throws error when mapping is not an object', () => {
    const arrayFile = join(testFixturesDir, 'array.json');
    writeFileSync(arrayFile, JSON.stringify(['ipfs.io', 'dweb.link']));

    expect(() => loadGatewayMapping(arrayFile)).toThrow(
      'Gateway mapping must be a JSON object'
    );
  });

  test('throws error when value is not a string', () => {
    const invalidValueFile = join(testFixturesDir, 'invalid-value.json');
    writeFileSync(
      invalidValueFile,
      JSON.stringify({
        'ipfs.io': ['dweb.link', 'backup.link'],
      })
    );

    expect(() => loadGatewayMapping(invalidValueFile)).toThrow(
      'Gateway mapping values must be strings'
    );
  });

  test('throws error on empty source after normalization', () => {
    const emptySourceFile = join(testFixturesDir, 'empty-source.json');
    writeFileSync(
      emptySourceFile,
      JSON.stringify({
        '': 'dweb.link',
      })
    );

    expect(() => loadGatewayMapping(emptySourceFile)).toThrow(
      'Empty source gateway after normalization'
    );
  });

  test('throws error on empty destination after normalization', () => {
    const emptyDestFile = join(testFixturesDir, 'empty-dest.json');
    writeFileSync(
      emptyDestFile,
      JSON.stringify({
        'ipfs.io': '',
      })
    );

    expect(() => loadGatewayMapping(emptyDestFile)).toThrow(
      'Empty destination gateway after normalization'
    );
  });
});

// ========================================
// normalizeUri() with Gateway Config Tests
// ========================================

describe('normalizeUri with gateway configuration', () => {
  describe('Default gateway configuration', () => {
    test('converts ipfs:// to default gateway', () => {
      const uri = 'ipfs://QmTest1234567890abcdefghijklmnop';
      const result = normalizeUri(uri);
      expect(result).toBe('https://ipfs.io/ipfs/QmTest1234567890abcdefghijklmnop');
    });

    test('converts ipfs:// to custom default gateway', () => {
      const uri = 'ipfs://QmTest1234567890abcdefghijklmnop/path/file.json';
      const config: GatewayConfig = {
        defaultGateway: 'custom-gateway.com',
        rewriteAllGateways: false,
        targetGateway: null,
        gatewayMapping: null,
      };
      const result = normalizeUri(uri, config);
      expect(result).toBe(
        'https://custom-gateway.com/ipfs/QmTest1234567890abcdefghijklmnop/path/file.json'
      );
    });

    test('supports private IP as default gateway', () => {
      const uri = 'ipfs://QmTest1234567890abcdefghijklmnop';
      const config: GatewayConfig = {
        defaultGateway: '192.168.1.100:8080',
        rewriteAllGateways: false,
        targetGateway: null,
        gatewayMapping: null,
      };
      const result = normalizeUri(uri, config);
      expect(result).toBe('https://192.168.1.100:8080/ipfs/QmTest1234567890abcdefghijklmnop');
    });
  });

  describe('Global gateway rewriting', () => {
    test('rewrites path-style gateway URLs', () => {
      const uri = 'https://ipfs.io/ipfs/QmTest1234567890abcdefghijklmnop';
      const config: GatewayConfig = {
        defaultGateway: 'ipfs.io',
        rewriteAllGateways: true,
        targetGateway: 'new-gateway.com',
        gatewayMapping: null,
      };
      const result = normalizeUri(uri, config);
      expect(result).toBe('https://new-gateway.com/ipfs/QmTest1234567890abcdefghijklmnop');
    });

    test('rewrites subdomain-style gateway URLs', () => {
      const uri = 'https://QmTest1234567890abcdefghijklmnop.ipfs.dweb.link/path/file.json';
      const config: GatewayConfig = {
        defaultGateway: 'ipfs.io',
        rewriteAllGateways: true,
        targetGateway: 'target-gateway.com',
        gatewayMapping: null,
      };
      const result = normalizeUri(uri, config);
      // Note: CID is lowercased because URL parser lowercases hostnames
      expect(result).toBe(
        'https://target-gateway.com/ipfs/qmtest1234567890abcdefghijklmnop/path/file.json'
      );
    });

    test('preserves paths after CID', () => {
      const uri = 'https://cloudflare-ipfs.com/ipfs/QmTest1234567890abcdefghijklmnop/registry.json';
      const config: GatewayConfig = {
        defaultGateway: 'ipfs.io',
        rewriteAllGateways: true,
        targetGateway: 'my-gateway.com',
        gatewayMapping: null,
      };
      const result = normalizeUri(uri, config);
      expect(result).toBe(
        'https://my-gateway.com/ipfs/QmTest1234567890abcdefghijklmnop/registry.json'
      );
    });

    test('does not rewrite non-gateway HTTPS URLs', () => {
      const uri = 'https://example.com/bcmr-registry.json';
      const config: GatewayConfig = {
        defaultGateway: 'ipfs.io',
        rewriteAllGateways: true,
        targetGateway: 'should-not-appear.com',
        gatewayMapping: null,
      };
      const result = normalizeUri(uri, config);
      expect(result).toBe('https://example.com/bcmr-registry.json');
    });
  });

  describe('Selective gateway mapping', () => {
    test('rewrites using gateway mapping', () => {
      const uri = 'https://ipfs.io/ipfs/QmTest1234567890abcdefghijklmnop';
      const mapping = new Map<string, string>();
      mapping.set('ipfs.io', 'dweb.link');

      const config: GatewayConfig = {
        defaultGateway: 'ipfs.io',
        rewriteAllGateways: false,
        targetGateway: null,
        gatewayMapping: mapping,
      };
      const result = normalizeUri(uri, config);
      expect(result).toBe('https://dweb.link/ipfs/QmTest1234567890abcdefghijklmnop');
    });

    test('leaves unmapped gateways unchanged', () => {
      const uri = 'https://unmapped-gateway.com/ipfs/QmTest1234567890abcdefghijklmnop';
      const mapping = new Map<string, string>();
      mapping.set('ipfs.io', 'dweb.link');

      const config: GatewayConfig = {
        defaultGateway: 'ipfs.io',
        rewriteAllGateways: false,
        targetGateway: null,
        gatewayMapping: mapping,
      };
      const result = normalizeUri(uri, config);
      expect(result).toBe('https://unmapped-gateway.com/ipfs/QmTest1234567890abcdefghijklmnop');
    });

    test('mapping works with subdomain-style URLs', () => {
      const uri = 'https://QmTest1234567890abcdefghijklmnop.ipfs.dweb.link/file.json';
      const mapping = new Map<string, string>();
      mapping.set('dweb.link', 'gateway.pinata.cloud');

      const config: GatewayConfig = {
        defaultGateway: 'ipfs.io',
        rewriteAllGateways: false,
        targetGateway: null,
        gatewayMapping: mapping,
      };
      const result = normalizeUri(uri, config);
      // Note: CID is lowercased because URL parser lowercases hostnames
      expect(result).toBe(
        'https://gateway.pinata.cloud/ipfs/qmtest1234567890abcdefghijklmnop/file.json'
      );
    });
  });

  describe('Priority: mapping > global rewrite > no change', () => {
    test('gateway mapping takes precedence over global rewrite', () => {
      const uri = 'https://ipfs.io/ipfs/QmTest1234567890abcdefghijklmnop';
      const mapping = new Map<string, string>();
      mapping.set('ipfs.io', 'mapped-gateway.com');

      const config: GatewayConfig = {
        defaultGateway: 'ipfs.io',
        rewriteAllGateways: true,
        targetGateway: 'global-gateway.com',
        gatewayMapping: mapping,
      };
      const result = normalizeUri(uri, config);
      // Should use mapping, not global rewrite
      expect(result).toBe('https://mapped-gateway.com/ipfs/QmTest1234567890abcdefghijklmnop');
    });

    test('global rewrite applies when no mapping matches', () => {
      const uri = 'https://dweb.link/ipfs/QmTest1234567890abcdefghijklmnop';
      const mapping = new Map<string, string>();
      mapping.set('ipfs.io', 'mapped-gateway.com'); // Different gateway

      const config: GatewayConfig = {
        defaultGateway: 'ipfs.io',
        rewriteAllGateways: true,
        targetGateway: 'global-gateway.com',
        gatewayMapping: mapping,
      };
      const result = normalizeUri(uri, config);
      // dweb.link not in mapping, should use global rewrite
      expect(result).toBe('https://global-gateway.com/ipfs/QmTest1234567890abcdefghijklmnop');
    });

    test('no change when neither mapping nor global rewrite apply', () => {
      const uri = 'https://some-gateway.com/ipfs/QmTest1234567890abcdefghijklmnop';
      const mapping = new Map<string, string>();
      mapping.set('ipfs.io', 'mapped-gateway.com');

      const config: GatewayConfig = {
        defaultGateway: 'ipfs.io',
        rewriteAllGateways: false, // Global rewrite disabled
        targetGateway: null,
        gatewayMapping: mapping,
      };
      const result = normalizeUri(uri, config);
      // Not in mapping, global rewrite disabled → no change
      expect(result).toBe('https://some-gateway.com/ipfs/QmTest1234567890abcdefghijklmnop');
    });
  });

  describe('Output format: always path-style', () => {
    test('path-style input → path-style output', () => {
      const uri = 'https://ipfs.io/ipfs/QmTest1234567890abcdefghijklmnop/path/file.json';
      const config: GatewayConfig = {
        defaultGateway: 'ipfs.io',
        rewriteAllGateways: true,
        targetGateway: 'new-gateway.com',
        gatewayMapping: null,
      };
      const result = normalizeUri(uri, config);
      expect(result).toBe(
        'https://new-gateway.com/ipfs/QmTest1234567890abcdefghijklmnop/path/file.json'
      );
      expect(result).toMatch(/^https:\/\/[^/]+\/ipfs\/Qm/);
    });

    test('subdomain-style input → path-style output', () => {
      const uri = 'https://QmTest1234567890abcdefghijklmnop.ipfs.dweb.link/path/file.json';
      const config: GatewayConfig = {
        defaultGateway: 'ipfs.io',
        rewriteAllGateways: true,
        targetGateway: 'new-gateway.com',
        gatewayMapping: null,
      };
      const result = normalizeUri(uri, config);
      // Note: CID is lowercased because URL parser lowercases hostnames
      expect(result).toBe(
        'https://new-gateway.com/ipfs/qmtest1234567890abcdefghijklmnop/path/file.json'
      );
      // Verify it's path-style, not subdomain-style
      expect(result).not.toMatch(/qm[a-zA-Z0-9]+\.ipfs\./);
    });
  });

  describe('Edge cases and security', () => {
    test('rejects internal/private IPs from blockchain URLs (before rewriting)', () => {
      const uri = 'https://192.168.1.1/ipfs/QmTest';
      expect(() => normalizeUri(uri)).toThrow('Internal/private hostnames not allowed');
    });

    test('allows private IPs in user-configured gateways (after rewriting)', () => {
      const uri = 'https://ipfs.io/ipfs/QmTest1234567890abcdefghijklmnop';
      const config: GatewayConfig = {
        defaultGateway: 'ipfs.io',
        rewriteAllGateways: true,
        targetGateway: '192.168.1.100:8080',
        gatewayMapping: null,
      };
      const result = normalizeUri(uri, config);
      expect(result).toBe('https://192.168.1.100:8080/ipfs/QmTest1234567890abcdefghijklmnop');
    });

    test('handles empty configuration (uses defaults)', () => {
      const uri = 'ipfs://QmTest1234567890abcdefghijklmnop';
      const result = normalizeUri(uri, undefined);
      expect(result).toBe('https://ipfs.io/ipfs/QmTest1234567890abcdefghijklmnop');
    });
  });
});
