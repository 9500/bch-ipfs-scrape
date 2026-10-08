/**
 * SSRF protection for URLs sourced from the blockchain
 *
 * BCMR URIs are attacker-controlled input. This module makes sure the tool
 * never fetches from internal/private network addresses on behalf of such
 * input, including via redirects or DNS names that resolve to private IPs.
 */

import { isIPv4, isIPv6 } from 'net';
import { lookup } from 'dns/promises';

/** Maximum redirect hops followed per fetch */
const MAX_REDIRECTS = 5;

/**
 * IPv4 ranges that must never be fetched from blockchain-sourced URLs
 * (RFC 1918, RFC 6598 CGNAT, loopback, link-local, "this network",
 * IETF protocol assignments, benchmarking, multicast, reserved, broadcast)
 */
const PRIVATE_IPV4_CIDRS: Array<[number, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
].map(([cidr, bits]) => [ipv4ToInt(cidr as string), bits as number]);

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

function isPrivateIPv4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  return PRIVATE_IPV4_CIDRS.some(([network, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) >>> 0 === network;
  });
}

/**
 * Expand an IPv6 address into its eight 16-bit groups
 * Handles "::" compression and a trailing dotted-quad (e.g. ::ffff:1.2.3.4)
 */
function expandIPv6(ip: string): number[] | null {
  let addr = ip;

  // Convert trailing embedded IPv4 (::ffff:192.168.1.1) into two hex groups
  const v4Match = addr.match(/:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4Match) {
    const v4 = ipv4ToInt(v4Match[1]);
    addr = addr.slice(0, -v4Match[1].length) + (v4 >>> 16).toString(16) + ':' + (v4 & 0xffff).toString(16);
  }

  const halves = addr.split('::');
  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;

  const groups = [...head, ...Array(missing).fill('0'), ...tail].map((g) => parseInt(g, 16));
  return groups.some((g) => Number.isNaN(g)) ? null : groups;
}

function isPrivateIPv6(ip: string): boolean {
  const groups = expandIPv6(ip);
  if (!groups) return true; // Unparseable - refuse rather than guess

  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  const embeddedV4 = `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;

  // :: (unspecified) and ::1 (loopback)
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 <= 1) {
    return true;
  }
  // IPv4-mapped (::ffff:a.b.c.d) and deprecated IPv4-compatible (::a.b.c.d)
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) {
    return isPrivateIPv4(embeddedV4);
  }
  // NAT64 well-known prefix 64:ff9b::/96 embeds an IPv4 address
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isPrivateIPv4(embeddedV4);
  }
  // Unique local fc00::/7, link-local fe80::/10, site-local fec0::/10 (deprecated), multicast ff00::/8
  if ((g0 & 0xfe00) === 0xfc00 || (g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0 || (g0 & 0xff00) === 0xff00) {
    return true;
  }
  return false;
}

/**
 * Check whether an IP address (v4 or v6, brackets optional) is internal/private
 */
export function isPrivateIP(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '');
  if (isIPv4(bare)) return isPrivateIPv4(bare);
  if (isIPv6(bare)) return isPrivateIPv6(bare);
  return false;
}

/**
 * Check if a hostname (as returned by URL.hostname) is an internal/private address
 * SECURITY: Prevents SSRF attacks targeting internal services
 *
 * Note: Node's URL parser already canonicalizes IPv4 shorthand such as
 * "127.1", "2130706433" or "0x7f000001" to dotted-decimal, and wraps IPv6
 * literals in brackets, so this only needs to handle canonical forms.
 */
export function isInternalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');

  if (host === 'localhost' || host.endsWith('.localhost')) {
    return true;
  }

  return isPrivateIP(host);
}

/**
 * Resolve a hostname and reject it if any of its addresses is private.
 * Covers public DNS names pointed at internal addresses. IP literals are
 * checked directly. A rebinding attacker could still change the answer
 * between this lookup and the connection, so this is defence in depth,
 * not a guarantee.
 */
async function assertResolvesToPublicIP(hostname: string): Promise<void> {
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (isIPv4(bare) || isIPv6(bare)) {
    if (isPrivateIP(bare)) {
      throw new Error(`Internal/private hostnames not allowed: ${hostname}`);
    }
    return;
  }

  const addresses = await lookup(bare, { all: true });
  for (const { address } of addresses) {
    if (isPrivateIP(address)) {
      throw new Error(`Hostname ${hostname} resolves to internal/private address ${address}`);
    }
  }
}

export interface SafeFetchOptions {
  signal?: AbortSignal;
  /** Maximum response body size in bytes; larger responses are rejected */
  maxBytes: number;
  /**
   * Host (URL.host form, e.g. "192.168.1.100:8080") that is trusted because the
   * user configured it as their gateway. Only an exact match is exempt from the
   * private-address checks; redirects away from it are validated normally.
   */
  trustedHost?: string | null;
}

export interface SafeFetchResult {
  status: number;
  ok: boolean;
  body: Buffer;
  /** Final URL after any redirects */
  url: string;
}

/**
 * Fetch a URL from blockchain-sourced input with SSRF protection:
 * - every hop (initial URL and each redirect target) is checked against
 *   private IP ranges, both as a literal and after DNS resolution
 * - redirects are followed manually (at most MAX_REDIRECTS)
 * - the body is streamed with a hard size cap
 * - the abort signal covers the body read, not just the headers
 */
export async function safeFetch(url: string, options: SafeFetchOptions): Promise<SafeFetchResult> {
  const { signal, maxBytes, trustedHost } = options;
  let current = new URL(url);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (current.protocol !== 'https:' && current.protocol !== 'http:') {
      throw new Error(`Unsupported protocol: ${current.protocol}`);
    }

    if (current.host !== trustedHost) {
      if (isInternalHostname(current.hostname)) {
        throw new Error(`Internal/private hostnames not allowed: ${current.hostname}`);
      }
      await assertResolvesToPublicIP(current.hostname);
    }

    const response = await fetch(current, { signal, redirect: 'manual' });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) {
        throw new Error(`Redirect (HTTP ${response.status}) without Location header`);
      }
      current = new URL(location, current);
      continue;
    }

    const body = await readBodyWithLimit(response, maxBytes, signal);
    return { status: response.status, ok: response.ok, body, url: current.href };
  }

  throw new Error(`Too many redirects (more than ${MAX_REDIRECTS})`);
}

async function readBodyWithLimit(response: Response, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'));
  if (declared > maxBytes) {
    await response.body?.cancel();
    throw new Error(`Response too large: ${declared} bytes (limit ${maxBytes})`);
  }

  if (!response.body) {
    return Buffer.alloc(0);
  }

  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = response.body.getReader();
  const onAbort = () => reader.cancel().catch(() => {});
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        throw new Error(`Response too large: exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }

  if (signal?.aborted) {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    throw err;
  }

  return Buffer.concat(chunks);
}
