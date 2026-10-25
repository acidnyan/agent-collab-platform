// SPDX-License-Identifier: Apache-2.0
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { verifyEnvelope } from '@acp/core';
import type { SignedEnvelope } from '@acp/core';
export class InMemoryRelay {
  private queues = new Map<string, SignedEnvelope[]>(); private seen = new Set<string>();
  constructor(readonly tamper?: (e: SignedEnvelope) => SignedEnvelope) {}
  send(envelope: SignedEnvelope): void {
    if (!verifyEnvelope(envelope)) throw new Error('INVALID_ENVELOPE');
    if (this.seen.has(envelope.payload.envelopeId)) throw new Error('REPLAYED_ENVELOPE');
    const queue = this.queues.get(envelope.payload.recipientDid) ?? [];
    if (queue.length >= 1000 || this.seen.size >= 100000) throw new Error('RELAY_CAPACITY');
    this.seen.add(envelope.payload.envelopeId);
    const wire = structuredClone(envelope); queue.push(this.tamper ? this.tamper(wire) : wire); this.queues.set(envelope.payload.recipientDid, queue);
  }
  receive(recipientDid: string): SignedEnvelope | undefined {
    const envelope = this.queues.get(recipientDid)?.shift();
    if (envelope && !verifyEnvelope(envelope, recipientDid)) throw new Error('RELAY_TAMPERING_DETECTED');
    return envelope;
  }
}
export async function startLocalRelay(options: { port?: number; tamper?: (e: SignedEnvelope) => SignedEnvelope } = {}) {
  const relay = new InMemoryRelay(options.tamper);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'POST' && url.pathname === '/envelopes') {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of request) { size += (chunk as Buffer).length; if (size > 1048576) throw new Error('BODY_TOO_LARGE'); chunks.push(chunk as Buffer); }
        relay.send(JSON.parse(Buffer.concat(chunks).toString()) as SignedEnvelope); response.writeHead(202).end();
      } else if (request.method === 'GET' && url.pathname === '/envelopes') {
        const value = relay.receive(url.searchParams.get('recipient') ?? ''); response.writeHead(value ? 200 : 204, { 'content-type': 'application/json' }).end(value ? JSON.stringify(value) : undefined);
      } else response.writeHead(404).end();
    } catch (e) { response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(e) })); }
  });
  server.requestTimeout = 5000;
  const wsServer = new WebSocketServer({ server, path: '/ws', maxPayload: 1048576 });
  wsServer.on('connection', socket => socket.on('message', raw => {
    try {
      const request = JSON.parse(raw.toString()) as { method: 'send' | 'receive'; envelope?: SignedEnvelope; recipientDid?: string };
      if (request.method === 'send' && request.envelope) { relay.send(request.envelope); socket.send(JSON.stringify({ ok: true })); }
      else if (request.method === 'receive' && request.recipientDid) socket.send(JSON.stringify({ envelope: relay.receive(request.recipientDid) ?? null }));
      else throw new Error('INVALID_REQUEST');
    } catch (e) { socket.send(JSON.stringify({ error: String(e) })); }
  }));
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('RELAY_BIND');
  return { url: 'http://127.0.0.1:' + address.port, wsUrl: 'ws://127.0.0.1:' + address.port + '/ws', close: async () => { for (const client of wsServer.clients) client.terminate(); await new Promise<void>(resolve => wsServer.close(() => resolve())); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); } };
}
export class HttpRelayClient {
  constructor(readonly url: string) {}
  async send(envelope: SignedEnvelope): Promise<void> { const result = await fetch(this.url + '/envelopes', { method: 'POST', body: JSON.stringify(envelope), headers: { 'content-type': 'application/json' } }); if (!result.ok) throw new Error('RELAY_REJECTED: ' + await result.text()); }
  async receive(recipientDid: string): Promise<SignedEnvelope | undefined> { const r = await fetch(this.url + '/envelopes?recipient=' + encodeURIComponent(recipientDid)); if (r.status === 204) return; if (!r.ok) throw new Error('RELAY_REJECTED'); const e = await r.json() as SignedEnvelope; if (!verifyEnvelope(e, recipientDid)) throw new Error('RELAY_TAMPERING_DETECTED'); return e; }
}
export class WebSocketRelayClient {
  private socket: WebSocket; private pending = false;
  constructor(url: string) { this.socket = new WebSocket(url); }
  async ready(): Promise<void> { if (this.socket.readyState === WebSocket.OPEN) return; await new Promise<void>((resolve, reject) => { this.socket.once('open', resolve); this.socket.once('error', reject); }); }
  private async request(body: unknown): Promise<{ error?: string; envelope?: SignedEnvelope }> {
    await this.ready(); if (this.pending) throw new Error('CONCURRENT_RELAY_REQUEST'); this.pending = true;
    try { return await new Promise((resolve, reject) => { const timer = setTimeout(() => { this.socket.removeListener('message', receive); reject(new Error('RELAY_TIMEOUT')); }, 5000); const receive = (raw: import('ws').RawData) => { clearTimeout(timer); try { const r = JSON.parse(raw.toString()) as { error?: string }; r.error ? reject(new Error(r.error)) : resolve(r); } catch (e) { reject(e); } }; this.socket.once('message', receive); this.socket.send(JSON.stringify(body)); }); } finally { this.pending = false; }
  }
  async send(envelope: SignedEnvelope): Promise<void> { await this.request({ method: 'send', envelope }); }
  async receive(recipientDid: string): Promise<SignedEnvelope | undefined> { const r = await this.request({ method: 'receive', recipientDid }); if (r.envelope && !verifyEnvelope(r.envelope, recipientDid)) throw new Error('RELAY_TAMPERING_DETECTED'); return r.envelope ?? undefined; }
  async close(): Promise<void> { if (this.socket.readyState === WebSocket.CLOSED) return; await new Promise<void>(resolve => { this.socket.once('close', resolve); this.socket.close(); }); }
}
