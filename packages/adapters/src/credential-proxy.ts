// SPDX-License-Identifier: Apache-2.0
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
/** Task-scoped loopback broker. Only the host fetch sees the real provider key. */
export async function startCredentialProxy(options: {
  apiKey: string;
  baseUrl: string;
  style: 'openai' | 'anthropic';
  signal: AbortSignal;
  fetch?: typeof fetch;
}) {
  const token = randomBytes(32).toString('base64url');
  const upstream = new URL(options.baseUrl);
  if (!['http:', 'https:'].includes(upstream.protocol)) throw new Error('INVALID_PROVIDER_URL');
  const server = createServer(async (request, response) => {
    try {
      if (
        request.headers.authorization !== 'Bearer ' + token &&
        request.headers['x-api-key'] !== token
      ) {
        response.writeHead(401).end();
        return;
      }
      const path = new URL(request.url ?? '/', 'http://localhost');
      if (
        request.method !== 'POST' ||
        ![
          '/v1/messages',
          '/v1/chat/completions',
          '/v1/responses',
          '/messages',
          '/chat/completions',
          '/responses',
        ].includes(path.pathname)
      ) {
        response.writeHead(403).end();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += (chunk as Buffer).length;
        if (size > 4194304) throw new Error('PROVIDER_REQUEST_LIMIT');
        chunks.push(chunk as Buffer);
      }
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (options.style === 'anthropic') {
        headers['x-api-key'] = options.apiKey;
        headers['anthropic-version'] = String(request.headers['anthropic-version'] ?? '2023-06-01');
        if (request.headers['anthropic-beta'])
          headers['anthropic-beta'] = String(request.headers['anthropic-beta']);
      } else headers.authorization = 'Bearer ' + options.apiKey;
      const target = new URL(upstream);
      target.pathname = upstream.pathname.replace(/\/$/, '') + path.pathname.replace(/^\/v1/, '');
      const result = await (options.fetch ?? fetch)(target, {
        method: 'POST',
        headers,
        body: Buffer.concat(chunks),
        signal: options.signal,
        redirect: 'error',
      });
      // Provider error bodies can contain account details; keep those in the host.
      if (!result.ok) {
        response.writeHead(result.status).end(JSON.stringify({ error: 'PROVIDER_REQUEST_FAILED' }));
        await result.body?.cancel();
        return;
      }
      response.writeHead(result.status, {
        'content-type': result.headers.get('content-type') ?? 'application/json',
      });
      const reader = result.body?.getReader();
      if (reader)
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (response.destroyed) break;
            response.write(value);
          }
        } finally {
          await reader.cancel();
        }
      response.end();
    } catch {
      if (!response.headersSent) response.writeHead(502);
      response.end(JSON.stringify({ error: 'PROVIDER_REQUEST_FAILED' }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('CREDENTIAL_PROXY_BIND_FAILED');
  return {
    url: 'http://127.0.0.1:' + address.port,
    token,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
