// SPDX-License-Identifier: Apache-2.0
import { verifySigned, resolveDid, verifySignedAgentCard, toA2AAgentCard } from '@acp/core/edge';
import type { SignedEnvelope, SignedAgentCard } from '@acp/core/edge';
// Same outer wire shape as envelope.schema.json, without filesystem schema loads.
export function verifyRelayEnvelope(e: SignedEnvelope, recipient?: string): boolean {
  try {
    const p = e.payload;
    resolveDid(p.senderDid); resolveDid(p.recipientDid);
    return Object.keys(e).sort().join() === 'payload,signature' && Object.keys(p).sort().join() === 'envelopeId,eventType,payload,recipientDid,senderDid,seq,taskId,type' && Object.keys(e.signature).sort().join() === 'canonicalization,payloadDigest,signature,signedAt,signerDid' && p.type === 'SignedEnvelope' && [p.envelopeId, p.taskId, p.eventType].every(s => typeof s === 'string' && s.length > 0) && Number.isSafeInteger(p.seq) && p.seq >= 0 && (!recipient || p.recipientDid === recipient) && verifySigned(e, p.senderDid);
  } catch { return false; }
}
export interface RelaySnapshot { queues: [string, SignedEnvelope[]][]; seen: string[]; agents: SignedAgentCard[] }
export class InMemoryRelay {
  private queues = new Map<string, SignedEnvelope[]>(); private seen = new Set<string>();
  private listeners = new Map<string, Set<() => void>>();
  readonly agents = new Map<string, SignedAgentCard>();
  constructor(readonly tamper?: (e: SignedEnvelope) => SignedEnvelope) {}
  send(envelope: SignedEnvelope): void {
    if (!verifyRelayEnvelope(envelope)) throw new Error('INVALID_ENVELOPE');
    if (this.seen.has(envelope.payload.envelopeId)) throw new Error('REPLAYED_ENVELOPE');
    const did = envelope.payload.recipientDid, queue = this.queues.get(did) ?? [];
    if (queue.length >= 1000 || this.seen.size >= 100000 || Buffer.byteLength(JSON.stringify(envelope)) > 1048576) throw new Error('RELAY_CAPACITY');
    this.seen.add(envelope.payload.envelopeId);
    const wire = structuredClone(envelope); queue.push(this.tamper ? this.tamper(wire) : wire); this.queues.set(did, queue);
    for (const fn of [...(this.listeners.get(did) ?? [])]) fn();
  }
  receive(recipientDid: string): SignedEnvelope | undefined {
    const envelope = this.queues.get(recipientDid)?.shift();
    if (envelope && !verifyRelayEnvelope(envelope, recipientDid)) throw new Error('RELAY_TAMPERING_DETECTED'); return envelope;
  }
  subscribe(did: string, fn: () => void): () => void {
    const set = this.listeners.get(did) ?? new Set(); set.add(fn); this.listeners.set(did, set);
    return () => { set.delete(fn); if (!set.size) this.listeners.delete(did); };
  }
  async wait(did: string, ms: number, signal?: AbortSignal): Promise<void> {
    if (this.queues.get(did)?.length || signal?.aborted || ms <= 0) return;
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); off(); signal?.removeEventListener('abort', done); resolve(); };
      const off = this.subscribe(did, done), timer = setTimeout(done, ms);
      signal?.addEventListener('abort', done, { once: true }); if (signal?.aborted) done();
    });
  }
  snapshot(): RelaySnapshot { return structuredClone({ queues: [...this.queues], seen: [...this.seen], agents: [...this.agents.values()] }); }
  restore(snapshot: RelaySnapshot): void {
    if (snapshot.seen.length > 100000 || snapshot.agents.length > 10000 || snapshot.queues.some(([did, q]) => q.length > 1000 || q.some(e => !verifyRelayEnvelope(e, did))) || snapshot.agents.some(c => !verifySignedAgentCard(c))) throw new Error('INVALID_RELAY_SNAPSHOT');
    this.queues = new Map(structuredClone(snapshot.queues)); this.seen = new Set(snapshot.seen); this.agents.clear();
    for (const card of snapshot.agents) this.agents.set(card.payload.agentDid, structuredClone(card));
  }
  discover(): SignedAgentCard[] { return structuredClone([...this.agents.values()]); }
  register(card: SignedAgentCard): void {
    if (!verifySignedAgentCard(card)) throw new Error('INVALID_AGENT_CARD');
    const old = this.agents.get(card.payload.agentDid);
    if (old && (old.payload.ownerDid !== card.payload.ownerDid || Date.parse(old.signature.signedAt) > Date.parse(card.signature.signedAt))) throw new Error('AGENT_OWNER_OR_VERSION_MISMATCH');
    if (!old && this.agents.size >= 10000) throw new Error('RELAY_CAPACITY');
    this.agents.set(card.payload.agentDid, structuredClone(card));
  }
}
export interface RelayFetchOptions { relay?: InMemoryRelay; agentCard?: SignedAgentCard }
export function createRelayFetchHandler(options: RelayFetchOptions = {}): (request: Request) => Promise<Response> {
  const relay = options.relay ?? new InMemoryRelay();
  const json = (value: unknown, status = 200) => Response.json(value, { status });
  async function body(request: Request): Promise<unknown> {
    if (Number(request.headers.get('content-length')) > 1048576) throw new Error('BODY_TOO_LARGE');
    const reader = request.body?.getReader(); if (!reader) throw new Error('MISSING_BODY');
    const chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 1048576) { await reader.cancel(); throw new Error('BODY_TOO_LARGE'); } chunks.push(value); } }
    finally { reader.releaseLock(); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  return async request => {
    try {
      const url = new URL(request.url), path = url.pathname;
      if (request.method === 'GET' && path === '/health') return json({ status: 'ok' });
      if (request.method === 'POST' && path === '/agents') { relay.register(await body(request) as SignedAgentCard); return json({ registered: true }, 201); }
      if (request.method === 'GET' && path === '/agents') return json([...relay.agents.values()]);
      if (request.method === 'GET' && path.startsWith('/agents/')) { const card = relay.agents.get(decodeURIComponent(path.slice(8))); return card ? json(card) : json({ error: 'NOT_FOUND' }, 404); }
      if (request.method === 'GET' && path === '/.well-known/agent.json') {
        const card = options.agentCard ?? relay.agents.values().next().value;
        return card ? json(toA2AAgentCard(card)) : json({ error: 'NO_AGENT_REGISTERED' }, 404);
      }
      if (request.method === 'POST' && path === '/envelopes') { relay.send(await body(request) as SignedEnvelope); return new Response(null, { status: 202 }); }
      if (request.method === 'GET' && ['/envelopes', '/stream'].includes(path)) {
        const recipient = url.searchParams.get('recipient') ?? ''; resolveDid(recipient);
        if (path === '/stream') {
          let stop = () => {};
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              const encoder = new TextEncoder(); let closed = false;
              const close = () => { if (closed) return; closed = true; off(); clearInterval(heartbeat); request.signal.removeEventListener('abort', close); try { controller.close(); } catch { /* Stream cancellation already closed the controller. */ } };
              const flush = () => { if (closed) return; try { let e; while ((e = relay.receive(recipient))) controller.enqueue(encoder.encode('data: ' + JSON.stringify(e) + '\n\n')); } catch (e) { close(); } };
              const off = relay.subscribe(recipient, flush);
              const heartbeat = setInterval(() => { if (!closed) controller.enqueue(encoder.encode(': heartbeat\n\n')); }, 15000);
              stop = close; request.signal.addEventListener('abort', close, { once: true });
              controller.enqueue(encoder.encode(': connected\n\n')); flush(); if (request.signal.aborted) close();
            }, cancel() { stop(); }
          });
          return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' } });
        }
        if (!url.searchParams.has('waitMs')) { const e = relay.receive(recipient); return e ? json(e) : new Response(null, { status: 204 }); }
        const ms = Number(url.searchParams.get('waitMs')); if (!Number.isFinite(ms) || ms < 0) throw new Error('INVALID_WAIT');
        await relay.wait(recipient, Math.min(ms, 30000), request.signal);
        const envelopes: SignedEnvelope[] = []; let e; while ((e = relay.receive(recipient))) envelopes.push(e); return json({ envelopes });
      }
      return json({ error: 'NOT_FOUND' }, 404);
    } catch (error) { return json({ error: String(error) }, 400); }
  };
}
