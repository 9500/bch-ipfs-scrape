/**
 * Fake Chaingraph (GraphQL over HTTP) for tests.
 *
 * Serves `search_output_prefix` from a fixture's rows, honouring `limit`
 * and `offset` (the real server caps a request at 5000 rows, which the
 * CLI pages around), and records every request.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeChaingraph {
  url: string;
  requests: Array<{ query: string; variables?: Record<string, unknown> }>;
  close: () => Promise<void>;
}

export async function startFakeChaingraph(rows: unknown[], options: { maxRows?: number } = {}): Promise<FakeChaingraph> {
  const maxRows = options.maxRows ?? 5000;
  const fake: FakeChaingraph = { url: '', requests: [], close: async () => {} };

  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const { query, variables } = JSON.parse(body) as { query: string; variables?: Record<string, unknown> };
      fake.requests.push({ query, variables });

      if (!query.includes('search_output_prefix')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ errors: [{ message: `fake Chaingraph does not implement: ${query.slice(0, 60)}` }] }));
        return;
      }

      // limit/offset from variables (paged default query) or inline in a custom query
      const inline = (name: string): number | undefined => {
        const m = query.match(new RegExp(`${name}:\\s*(\\d+)`));
        return m ? Number(m[1]) : undefined;
      };
      const limit = Number(variables?.limit ?? inline('limit') ?? maxRows);
      const offset = Number(variables?.offset ?? inline('offset') ?? 0);
      const page = rows.slice(offset, offset + Math.min(limit, maxRows));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: { search_output_prefix: page } }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/graphql`;
  fake.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  return fake;
}
