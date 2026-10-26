// SPDX-License-Identifier: Apache-2.0
import {
  verifySigned,
  resolveDid,
  verifySignedAgentCard,
  toA2AAgentCard,
  verifyRelayAuthToken,
  createRelayAuthToken,
} from '@acp/core/edge';
import type { SignedEnvelope, SignedAgentCard, RelayAuthAction, KeyPair } from '@acp/core/edge';
// Same outer wire shape as envelope.schema.json, without filesystem schema loads.
export function verifyRelayEnvelope(e: SignedEnvelope, recipient?: string): boolean {
  try {
    const p = e.payload;
    resolveDid(p.senderDid);
    resolveDid(p.recipientDid);
    return (
      Object.keys(e).sort().join() === 'payload,signature' &&
      Object.keys(p).sort().join() ===
        'envelopeId,eventType,payload,recipientDid,senderDid,seq,taskId,type' &&
      Object.keys(e.signature).sort().join() ===
        'canonicalization,payloadDigest,signature,signedAt,signerDid' &&
      p.type === 'SignedEnvelope' &&
      [p.envelopeId, p.taskId, p.eventType].every((s) => typeof s === 'string' && s.length > 0) &&
      Number.isSafeInteger(p.seq) &&
      p.seq >= 0 &&
      (!recipient || p.recipientDid === recipient) &&
      verifySigned(e, p.senderDid)
    );
  } catch {
    return false;
  }
}
export interface RelaySnapshot {
  queues: [string, SignedEnvelope[]][];
  seen: string[];
  authSeen?: string[];
  agents: SignedAgentCard[];
}
export interface InMemoryRelayOptions {
  requireAuth?: boolean;
  maxSeenEntries?: number;
  maxAuthSeenEntries?: number;
  maxQueues?: number;
  tamper?: (e: SignedEnvelope) => SignedEnvelope;
}
export class InMemoryRelay {
  private queues = new Map<string, SignedEnvelope[]>();
  private seen = new Set<string>();
  private authSeen = new Set<string>();
  private version = 0;
  get mutationVersion(): number {
    return this.version;
  }
  private listeners = new Map<string, Set<() => void>>();
  readonly agents = new Map<string, SignedAgentCard>();
  readonly tamper?: (e: SignedEnvelope) => SignedEnvelope;
  readonly requireAuth: boolean;
  readonly maxSeenEntries: number;
  readonly maxAuthSeenEntries: number;
  readonly maxQueues: number;
  constructor(options?: InMemoryRelayOptions | ((e: SignedEnvelope) => SignedEnvelope)) {
    const config = typeof options === 'function' ? { tamper: options } : (options ?? {});
    this.tamper = config.tamper;
    this.requireAuth = config.requireAuth ?? false;
    this.maxSeenEntries = config.maxSeenEntries ?? 100000;
    this.maxAuthSeenEntries = config.maxAuthSeenEntries ?? this.maxSeenEntries;
    this.maxQueues = config.maxQueues ?? 10000;
    for (const limit of [this.maxSeenEntries, this.maxAuthSeenEntries, this.maxQueues])
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('INVALID_RELAY_LIMIT');
  }
  private remember(set: Set<string>, key: string, limit: number): void {
    if (set.size >= limit) {
      const oldest = set.values().next().value;
      if (oldest !== undefined) set.delete(oldest);
    }
    set.add(key);
    this.version++;
  }
  authenticate(recipientDid: string, token?: string, action?: RelayAuthAction): boolean {
    const result = verifyRelayAuthToken(token ?? '', recipientDid);
    if (!result.valid || (action !== undefined && result.action !== action)) return false;
    const key = recipientDid + ':' + result.nonce;
    if (this.authSeen.has(key)) return false;
    this.remember(this.authSeen, key, this.maxAuthSeenEntries);
    return true;
  }
  /** Authenticate once for a long poll or persistent stream, then read only this inbox. */
  openInbox(
    recipientDid: string,
    token?: string,
    action: RelayAuthAction = 'receive',
  ): () => SignedEnvelope | undefined {
    if (!this.authenticate(recipientDid, token, action)) throw new Error('RELAY_UNAUTHORIZED');
    return () => this.dequeue(recipientDid);
  }
  private ensureQueue(did: string): SignedEnvelope[] {
    let queue = this.queues.get(did);
    if (!queue) {
      if (this.queues.size >= this.maxQueues) throw new Error('RELAY_CAPACITY');
      queue = [];
      this.queues.set(did, queue);
    }
    return queue;
  }
  send(envelope: SignedEnvelope): void {
    if (!verifyRelayEnvelope(envelope)) throw new Error('INVALID_ENVELOPE');
    if (this.seen.has(envelope.payload.envelopeId)) throw new Error('REPLAYED_ENVELOPE');
    const did = envelope.payload.recipientDid,
      queue = this.queues.get(did) ?? [];
    if (
      (!this.queues.has(did) && this.queues.size >= this.maxQueues) ||
      queue.length >= 1000 ||
      Buffer.byteLength(JSON.stringify(envelope)) > 1048576
    )
      throw new Error('RELAY_CAPACITY');
    this.remember(this.seen, envelope.payload.envelopeId, this.maxSeenEntries);
    const wire = structuredClone(envelope);
    queue.push(this.tamper ? this.tamper(wire) : wire);
    this.queues.set(did, queue);
    for (const fn of [...(this.listeners.get(did) ?? [])]) fn();
  }
  receive(
    recipientDid: string,
    authToken?: string | number,
    _signal?: AbortSignal,
  ): SignedEnvelope | undefined {
    if (
      (typeof authToken === 'string' || this.requireAuth) &&
      !this.authenticate(
        recipientDid,
        typeof authToken === 'string' ? authToken : undefined,
        'receive',
      )
    )
      throw new Error('RELAY_UNAUTHORIZED');
    return this.dequeue(recipientDid);
  }
  private dequeue(recipientDid: string): SignedEnvelope | undefined {
    const q = this.queues.get(recipientDid),
      envelope = q?.shift();
    if (q && !q.length) this.queues.delete(recipientDid);
    if (envelope) this.version++;
    if (envelope && !verifyRelayEnvelope(envelope, recipientDid))
      throw new Error('RELAY_TAMPERING_DETECTED');
    return envelope;
  }
  withRecipient(key: KeyPair) {
    return {
      send: (e: SignedEnvelope) => this.send(e),
      receive: (did: string) => this.receive(did, createRelayAuthToken(key)),
      register: (card: SignedAgentCard) => this.register(card),
      discover: () => this.discover(),
    };
  }
  subscribe(did: string, fn: () => void): () => void {
    this.ensureQueue(did);
    const set = this.listeners.get(did) ?? new Set();
    set.add(fn);
    this.listeners.set(did, set);
    return () => {
      set.delete(fn);
      if (!set.size) {
        this.listeners.delete(did);
        if (!this.queues.get(did)?.length) this.queues.delete(did);
      }
    };
  }
  async wait(did: string, ms: number, signal?: AbortSignal): Promise<void> {
    if (this.queues.get(did)?.length || signal?.aborted || ms <= 0) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        off();
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const off = this.subscribe(did, done),
        timer = setTimeout(done, ms);
      signal?.addEventListener('abort', done, { once: true });
      if (signal?.aborted) done();
    });
  }
  snapshot(): RelaySnapshot {
    return structuredClone({
      queues: [...this.queues],
      seen: [...this.seen],
      authSeen: [...this.authSeen],
      agents: [...this.agents.values()],
    });
  }
  restore(snapshot: RelaySnapshot): void {
    if (
      snapshot.seen.length > this.maxSeenEntries ||
      (snapshot.authSeen?.length ?? 0) > this.maxAuthSeenEntries ||
      snapshot.queues.length > this.maxQueues ||
      snapshot.agents.length > 10000 ||
      snapshot.queues.some(
        ([did, q]) => q.length > 1000 || q.some((e) => !verifyRelayEnvelope(e, did)),
      ) ||
      snapshot.agents.some((c) => !verifySignedAgentCard(c))
    )
      throw new Error('INVALID_RELAY_SNAPSHOT');
    this.queues = new Map(structuredClone(snapshot.queues));
    this.seen = new Set(snapshot.seen);
    this.authSeen = new Set(snapshot.authSeen ?? []);
    this.agents.clear();
    for (const card of snapshot.agents)
      this.agents.set(card.payload.agentDid, structuredClone(card));
    this.version++;
  }
  discover(): SignedAgentCard[] {
    return structuredClone([...this.agents.values()]);
  }
  register(card: SignedAgentCard): void {
    if (!verifySignedAgentCard(card)) throw new Error('INVALID_AGENT_CARD');
    const old = this.agents.get(card.payload.agentDid);
    if (
      old &&
      (old.payload.ownerDid !== card.payload.ownerDid ||
        Date.parse(old.signature.signedAt) > Date.parse(card.signature.signedAt))
    )
      throw new Error('AGENT_OWNER_OR_VERSION_MISMATCH');
    if (!old && this.agents.size >= 10000) throw new Error('RELAY_CAPACITY');
    this.agents.set(card.payload.agentDid, structuredClone(card));
    this.version++;
  }
}
export interface RelayFetchOptions {
  relay?: InMemoryRelay;
  agentCard?: SignedAgentCard;
}
/** Defensive headers for any relay URL opened directly in a browser. */
export function relayHttpHeaders(kind: 'json' | 'empty' | 'sse' = 'json'): Record<string, string> {
  return {
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cache-control': kind === 'sse' ? 'no-cache, no-store' : 'no-store',
    ...(kind === 'json' ? { 'content-type': 'application/json; charset=utf-8' } : {}),
    ...(kind === 'sse' ? { 'content-type': 'text/event-stream', 'x-accel-buffering': 'no' } : {}),
  };
}
export function createRelayFetchHandler(
  options: RelayFetchOptions = {},
): (request: Request) => Promise<Response> {
  const relay = options.relay ?? new InMemoryRelay();
  const json = (value: unknown, status = 200) =>
    Response.json(value, { status, headers: relayHttpHeaders('json') });
  const empty = (status: 202 | 204) =>
    new Response(null, { status, headers: relayHttpHeaders('empty') });
  async function body(request: Request): Promise<unknown> {
    if (Number(request.headers.get('content-length')) > 1048576) throw new Error('BODY_TOO_LARGE');
    const reader = request.body?.getReader();
    if (!reader) throw new Error('MISSING_BODY');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1048576) {
          await reader.cancel();
          throw new Error('BODY_TOO_LARGE');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  return async (request) => {
    try {
      const url = new URL(request.url),
        path = url.pathname;
      if (request.method === 'GET' && path === '/health') return json({ status: 'ok' });
      if (request.method === 'POST' && path === '/agents') {
        relay.register((await body(request)) as SignedAgentCard);
        return json({ registered: true }, 201);
      }
      if (request.method === 'GET' && path === '/agents') return json([...relay.agents.values()]);
      if (request.method === 'GET' && path.startsWith('/agents/')) {
        const card = relay.agents.get(decodeURIComponent(path.slice(8)));
        return card ? json(card) : json({ error: 'NOT_FOUND' }, 404);
      }
      if (request.method === 'GET' && path === '/.well-known/agent.json') {
        const card = options.agentCard ?? relay.agents.values().next().value;
        return card ? json(toA2AAgentCard(card)) : json({ error: 'NO_AGENT_REGISTERED' }, 404);
      }
      if (request.method === 'POST' && path === '/envelopes') {
        relay.send((await body(request)) as SignedEnvelope);
        return empty(202);
      }
      if (request.method === 'GET' && ['/envelopes', '/stream'].includes(path)) {
        const recipient = url.searchParams.get('recipient') ?? '';
        resolveDid(recipient);
        const ms = url.searchParams.has('waitMs')
          ? Number(url.searchParams.get('waitMs'))
          : undefined;
        if (ms !== undefined && (!Number.isFinite(ms) || ms < 0)) throw new Error('INVALID_WAIT');
        const token =
          request.headers.get('authorization')?.match(/^Bearer (\S+)$/i)?.[1] ??
          request.headers.get('x-acp-relay-auth') ??
          url.searchParams.get('auth') ??
          undefined;
        const receive = relay.openInbox(
          recipient,
          token,
          path === '/stream' ? 'stream' : 'receive',
        );
        if (path === '/stream') {
          let stop = () => {};
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              const encoder = new TextEncoder();
              let closed = false;
              const close = () => {
                if (closed) return;
                closed = true;
                off();
                clearInterval(heartbeat);
                request.signal.removeEventListener('abort', close);
                try {
                  controller.close();
                } catch {
                  /* Stream cancellation already closed the controller. */
                }
              };
              const flush = () => {
                if (closed) return;
                try {
                  let e;
                  while ((e = receive()))
                    controller.enqueue(encoder.encode('data: ' + JSON.stringify(e) + '\n\n'));
                } catch (e) {
                  close();
                }
              };
              const off = relay.subscribe(recipient, flush);
              const heartbeat = setInterval(() => {
                if (!closed) controller.enqueue(encoder.encode(': heartbeat\n\n'));
              }, 15000);
              stop = close;
              request.signal.addEventListener('abort', close, { once: true });
              controller.enqueue(encoder.encode(': connected\n\n'));
              flush();
              if (request.signal.aborted) close();
            },
            cancel() {
              stop();
            },
          });
          return new Response(stream, { headers: relayHttpHeaders('sse') });
        }
        if (!url.searchParams.has('waitMs')) {
          const e = receive();
          return e ? json(e) : empty(204);
        }
        await relay.wait(recipient, Math.min(ms!, 30000), request.signal);
        const envelopes: SignedEnvelope[] = [];
        let e;
        while ((e = receive())) envelopes.push(e);
        return json({ envelopes });
      }
      return json({ error: 'NOT_FOUND' }, 404);
    } catch (error) {
      return error instanceof Error && error.message === 'RELAY_UNAUTHORIZED'
        ? json({ error: 'RELAY_UNAUTHORIZED' }, 401)
        : json({ error: String(error) }, 400);
    }
  };
}
