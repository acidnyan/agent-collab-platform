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
/** Single signed envelope JSON body. Larger bodies are rejected before they are queued. */
export const DEFAULT_MAX_ENVELOPE_BYTES = 256 * 1024;
/** Unread envelopes kept for one recipient. */
export const DEFAULT_MAX_QUEUE_SIZE = 256;
/** Sum of queued envelope JSON sizes for one recipient. */
export const DEFAULT_MAX_QUEUE_BYTES_PER_RECIPIENT = 4 * 1024 * 1024;
export const DEFAULT_ENVELOPE_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_SEEN_TTL_MS = 60 * 60 * 1000;
export const DEFAULT_AUTH_SEEN_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_AGENT_CARD_TTL_MS = 60 * 60 * 1000;
/** Caps the durable replay ring scanned when an inbox object wakes. */
export const DEFAULT_MAX_SEEN_ENTRIES = 4096;
export const DEFAULT_MAX_QUEUES = 10000;
export const DEFAULT_MAX_AGENTS = 10000;

export interface RelaySnapshot {
  queues: [string, SignedEnvelope[]][];
  seen: string[];
  authSeen?: string[];
  agents: SignedAgentCard[];
  envelopeExpiry?: [string, number][];
  seenExpiry?: [string, number][];
  authExpiry?: [string, number][];
  agentExpiry?: [string, number][];
}
export interface InMemoryRelayOptions {
  requireAuth?: boolean;
  /**
   * Direct and network checks accept a `RelayAuth` token that omits `origin`.
   * A token that includes a different origin is still rejected.
   */
  allowUnboundRelayAuth?: boolean;
  maxSeenEntries?: number;
  maxAuthSeenEntries?: number;
  maxQueues?: number;
  maxQueueSize?: number;
  maxEnvelopeBytes?: number;
  maxQueueBytesPerRecipient?: number;
  maxEnvelopesPerSender?: number;
  maxAgents?: number;
  envelopeTtlMs?: number;
  seenTtlMs?: number;
  authSeenTtlMs?: number;
  agentCardTtlMs?: number;
  now?: () => number;
  tamper?: (e: SignedEnvelope) => SignedEnvelope;
}
interface StoredEnvelope {
  envelope: SignedEnvelope;
  bytes: number;
  expiresAt: number;
}
function positiveLimit(value: number | undefined, fallback: number): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('INVALID_RELAY_LIMIT');
  return limit;
}
export function relayLimitsFromEnv(env?: Record<string, unknown>): InMemoryRelayOptions {
  const read = (key: string): number | undefined => {
    const value = env?.[key];
    if (typeof value !== 'string' || value === '') return undefined;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : undefined;
  };
  return {
    maxEnvelopeBytes: read('ACP_MAX_ENVELOPE_BYTES'),
    maxQueueSize: read('ACP_MAX_QUEUE_SIZE'),
    maxQueueBytesPerRecipient: read('ACP_MAX_QUEUE_BYTES'),
    maxEnvelopesPerSender: read('ACP_MAX_ENVELOPES_PER_SENDER'),
    maxSeenEntries: read('ACP_MAX_SEEN_ENTRIES'),
    envelopeTtlMs: read('ACP_ENVELOPE_TTL_MS'),
    seenTtlMs: read('ACP_SEEN_TTL_MS'),
    authSeenTtlMs: read('ACP_AUTH_SEEN_TTL_MS'),
    agentCardTtlMs: read('ACP_AGENT_CARD_TTL_MS'),
    maxAgents: read('ACP_MAX_AGENTS'),
  };
}
export function canonicalRelayPath(pathname: string): string {
  if (pathname === '/v1') return '/';
  if (pathname.startsWith('/v1/')) return pathname.slice(3);
  return pathname;
}
/**
 * Registry identity for one owner's registration of one agent.
 * did:key values do not contain "/", so the pair round-trips unambiguously.
 */
export function agentRegistryKey(ownerDid: string, agentDid: string): string {
  return ownerDid + '/' + agentDid;
}
/**
 * GET /agents/:agentDid returns the only card for that agent, or the self-owned
 * card when several owners have registered it. An ambiguous set with no self-owned
 * card is not returned.
 */
export function selectAgentCard(
  cards: Iterable<SignedAgentCard>,
  agentDid: string,
): SignedAgentCard | undefined {
  const matches: SignedAgentCard[] = [];
  for (const card of cards) if (card.payload.agentDid === agentDid) matches.push(card);
  if (matches.length === 1) return matches[0];
  return matches.find((card) => card.payload.ownerDid === card.payload.agentDid);
}
export class InMemoryRelay {
  private queues = new Map<string, StoredEnvelope[]>();
  private seen = new Map<string, number>();
  private authSeen = new Map<string, number>();
  private agentExpiry = new Map<string, number>();
  private version = 0;
  get mutationVersion(): number {
    return this.version;
  }
  private listeners = new Map<string, Set<() => void>>();
  /** Keyed by agentRegistryKey(ownerDid, agentDid). One owner cannot block another. */
  readonly agents = new Map<string, SignedAgentCard>();
  readonly tamper?: (e: SignedEnvelope) => SignedEnvelope;
  readonly requireAuth: boolean;
  readonly allowUnboundRelayAuth: boolean;
  readonly maxSeenEntries: number;
  readonly maxAuthSeenEntries: number;
  readonly maxQueues: number;
  readonly maxQueueSize: number;
  readonly maxEnvelopeBytes: number;
  readonly maxQueueBytesPerRecipient: number;
  readonly maxEnvelopesPerSender: number;
  readonly maxAgents: number;
  readonly envelopeTtlMs: number;
  readonly seenTtlMs: number;
  readonly authSeenTtlMs: number;
  readonly agentCardTtlMs: number;
  private readonly now: () => number;
  constructor(options?: InMemoryRelayOptions | ((e: SignedEnvelope) => SignedEnvelope)) {
    const config = typeof options === 'function' ? { tamper: options } : (options ?? {});
    this.tamper = config.tamper;
    this.requireAuth = config.requireAuth ?? false;
    this.allowUnboundRelayAuth = config.allowUnboundRelayAuth ?? false;
    this.maxSeenEntries = positiveLimit(config.maxSeenEntries, DEFAULT_MAX_SEEN_ENTRIES);
    this.maxAuthSeenEntries = positiveLimit(
      config.maxAuthSeenEntries,
      this.maxSeenEntries,
    );
    this.maxQueues = positiveLimit(config.maxQueues, DEFAULT_MAX_QUEUES);
    this.maxQueueSize = positiveLimit(config.maxQueueSize, DEFAULT_MAX_QUEUE_SIZE);
    this.maxEnvelopeBytes = positiveLimit(config.maxEnvelopeBytes, DEFAULT_MAX_ENVELOPE_BYTES);
    this.maxQueueBytesPerRecipient = positiveLimit(
      config.maxQueueBytesPerRecipient,
      DEFAULT_MAX_QUEUE_BYTES_PER_RECIPIENT,
    );
    this.maxEnvelopesPerSender = positiveLimit(
      config.maxEnvelopesPerSender,
      this.maxQueueSize,
    );
    this.maxAgents = positiveLimit(config.maxAgents, DEFAULT_MAX_AGENTS);
    this.envelopeTtlMs = positiveLimit(config.envelopeTtlMs, DEFAULT_ENVELOPE_TTL_MS);
    this.seenTtlMs = positiveLimit(config.seenTtlMs, DEFAULT_SEEN_TTL_MS);
    this.authSeenTtlMs = positiveLimit(config.authSeenTtlMs, DEFAULT_AUTH_SEEN_TTL_MS);
    this.agentCardTtlMs = positiveLimit(config.agentCardTtlMs, DEFAULT_AGENT_CARD_TTL_MS);
    this.now = config.now ?? Date.now;
  }
  private remember(map: Map<string, number>, key: string, limit: number, ttlMs: number): void {
    const now = this.now();
    for (const [entry, expiresAt] of map) if (expiresAt <= now) map.delete(entry);
    if (map.size >= limit) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
    map.set(key, now + ttlMs);
    this.version++;
  }
  authenticate(
    recipientDid: string,
    token?: string,
    action?: RelayAuthAction,
    check?: RelayAuthContext,
  ): boolean {
    this.evictExpired();
    const result = verifyRelayAuthToken(token ?? '', recipientDid, {
      expectedOrigin: check?.expectedOrigin,
      requireOrigin: check?.requireOrigin,
    });
    if (!result.valid) {
      if (
        result.reason === 'RELAY_AUTH_ORIGIN_MISMATCH' ||
        result.reason === 'RELAY_AUTH_ORIGIN_REQUIRED'
      )
        throw new Error(result.reason);
      return false;
    }
    if (action !== undefined && result.action !== action) return false;
    const key = recipientDid + ':' + result.nonce;
    if (this.authSeen.has(key)) return false;
    this.remember(this.authSeen, key, this.maxAuthSeenEntries, this.authSeenTtlMs);
    return true;
  }
  /** Authenticate once for a long poll or persistent stream, then read only this inbox. */
  openInbox(
    recipientDid: string,
    token?: string,
    action: RelayAuthAction = 'receive',
    check?: RelayAuthContext,
  ): () => SignedEnvelope | undefined {
    if (!this.authenticate(recipientDid, token, action, check))
      throw new Error('RELAY_UNAUTHORIZED');
    return () => this.dequeue(recipientDid);
  }
  private ensureQueue(did: string): StoredEnvelope[] {
    let queue = this.queues.get(did);
    if (!queue) {
      if (this.queues.size >= this.maxQueues) throw new Error('RELAY_CAPACITY');
      queue = [];
      this.queues.set(did, queue);
    }
    return queue;
  }
  /** Drop queued envelopes, replay ids, and agent cards whose TTL has elapsed. */
  evictExpired(): void {
    const now = this.now();
    let changed = false;
    for (const [did, queue] of this.queues) {
      const live = queue.filter((item) => item.expiresAt > now);
      if (live.length === queue.length) continue;
      changed = true;
      if (live.length || this.listeners.get(did)?.size) this.queues.set(did, live);
      else this.queues.delete(did);
    }
    for (const map of [this.seen, this.authSeen, this.agentExpiry]) {
      for (const [key, expiresAt] of map) {
        if (expiresAt > now) continue;
        map.delete(key);
        changed = true;
        if (map === this.agentExpiry) this.agents.delete(key);
      }
    }
    if (changed) this.version++;
  }
  private queuedBytes(queue: StoredEnvelope[]): number {
    let total = 0;
    for (const item of queue) total += item.bytes;
    return total;
  }
  private senderCount(queue: StoredEnvelope[], senderDid: string): number {
    let total = 0;
    for (const item of queue) if (item.envelope.payload.senderDid === senderDid) total++;
    return total;
  }
  send(envelope: SignedEnvelope): void {
    if (!verifyRelayEnvelope(envelope)) throw new Error('INVALID_ENVELOPE');
    this.evictExpired();
    if (this.seen.has(envelope.payload.envelopeId)) throw new Error('REPLAYED_ENVELOPE');
    const did = envelope.payload.recipientDid;
    const queue = this.queues.get(did) ?? [];
    const bytes = Buffer.byteLength(JSON.stringify(envelope));
    if (!this.queues.has(did) && this.queues.size >= this.maxQueues)
      throw new Error('RELAY_CAPACITY');
    if (queue.length >= this.maxQueueSize || bytes > this.maxEnvelopeBytes)
      throw new Error('RELAY_CAPACITY');
    if (this.queuedBytes(queue) + bytes > this.maxQueueBytesPerRecipient)
      throw new Error('QUEUE_BYTES_EXCEEDED');
    if (this.senderCount(queue, envelope.payload.senderDid) >= this.maxEnvelopesPerSender)
      throw new Error('SENDER_QUOTA_EXCEEDED');
    this.remember(this.seen, envelope.payload.envelopeId, this.maxSeenEntries, this.seenTtlMs);
    const wire = structuredClone(envelope);
    const stored = this.tamper ? this.tamper(wire) : wire;
    queue.push({
      envelope: stored,
      bytes: Buffer.byteLength(JSON.stringify(stored)),
      expiresAt: this.now() + this.envelopeTtlMs,
    });
    this.queues.set(did, queue);
    for (const fn of [...(this.listeners.get(did) ?? [])]) fn();
  }
  receive(
    recipientDid: string,
    authToken?: string | number,
    _signal?: AbortSignal,
    check?: RelayAuthContext,
  ): SignedEnvelope | undefined {
    if (
      (typeof authToken === 'string' || this.requireAuth) &&
      !this.authenticate(
        recipientDid,
        typeof authToken === 'string' ? authToken : undefined,
        'receive',
        check,
      )
    )
      throw new Error('RELAY_UNAUTHORIZED');
    return this.dequeue(recipientDid);
  }
  private dequeue(recipientDid: string): SignedEnvelope | undefined {
    this.evictExpired();
    const q = this.queues.get(recipientDid);
    const item = q?.shift();
    if (q && !q.length && !this.listeners.get(recipientDid)?.size) this.queues.delete(recipientDid);
    if (item) this.version++;
    if (item && !verifyRelayEnvelope(item.envelope, recipientDid))
      throw new Error('RELAY_TAMPERING_DETECTED');
    return item?.envelope;
  }
  /** Recipient-authenticated removal of one queued envelope. False when it is not queued. */
  acknowledge(
    recipientDid: string,
    envelopeId: string,
    token?: string,
    check?: RelayAuthContext,
  ): boolean {
    this.evictExpired();
    if (!this.authenticate(recipientDid, token, 'receive', check))
      throw new Error('RELAY_UNAUTHORIZED');
    const queue = this.queues.get(recipientDid);
    if (!queue) return false;
    const index = queue.findIndex((item) => item.envelope.payload.envelopeId === envelopeId);
    if (index < 0) return false;
    queue.splice(index, 1);
    if (!queue.length && !this.listeners.get(recipientDid)?.size) this.queues.delete(recipientDid);
    this.version++;
    return true;
  }
  /** Seconds until the soonest queued item expires, for Retry-After. */
  retryAfterSeconds(): number {
    const next = this.nextExpiry();
    if (next === undefined) return 60;
    return Math.max(1, Math.ceil((next - this.now()) / 1000));
  }
  nextExpiry(): number | undefined {
    const now = this.now();
    let soonest = Infinity;
    const consider = (value: number) => {
      if (value > now && value < soonest) soonest = value;
    };
    for (const queue of this.queues.values()) for (const item of queue) consider(item.expiresAt);
    for (const expiresAt of this.seen.values()) consider(expiresAt);
    for (const expiresAt of this.authSeen.values()) consider(expiresAt);
    for (const expiresAt of this.agentExpiry.values()) consider(expiresAt);
    return Number.isFinite(soonest) ? soonest : undefined;
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
    this.evictExpired();
    if (signal?.aborted || ms <= 0 || this.queues.get(did)?.length) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const off = this.subscribe(did, done),
        timer = setTimeout(done, ms);
      signal?.addEventListener('abort', done, { once: true });
      // Cover the gap between the length check and listener installation.
      if (signal?.aborted || this.queues.get(did)?.length) done();
    });
  }
  snapshot(): RelaySnapshot {
    this.evictExpired();
    const envelopeExpiry: [string, number][] = [];
    const queues: [string, SignedEnvelope[]][] = [];
    for (const [did, queue] of this.queues) {
      const envelopes: SignedEnvelope[] = [];
      for (const item of queue) {
        envelopes.push(item.envelope);
        envelopeExpiry.push([item.envelope.payload.envelopeId, item.expiresAt]);
      }
      queues.push([did, envelopes]);
    }
    return structuredClone({
      queues,
      seen: [...this.seen.keys()],
      authSeen: [...this.authSeen.keys()],
      agents: [...this.agents.values()],
      envelopeExpiry,
      seenExpiry: [...this.seen],
      authExpiry: [...this.authSeen],
      agentExpiry: [...this.agentExpiry],
    });
  }
  restore(snapshot: RelaySnapshot): void {
    const seenExpiry = new Map(snapshot.seenExpiry ?? []);
    const authExpiry = new Map(snapshot.authExpiry ?? []);
    const envelopeExpiry = new Map(snapshot.envelopeExpiry ?? []);
    const agentExpiry = new Map(snapshot.agentExpiry ?? []);
    if (
      snapshot.seen.length > this.maxSeenEntries ||
      (snapshot.authSeen?.length ?? 0) > this.maxAuthSeenEntries ||
      snapshot.queues.length > this.maxQueues ||
      snapshot.agents.length > this.maxAgents ||
      snapshot.queues.some(([did, queue]) => {
        if (queue.length > this.maxQueueSize) return true;
        let bytes = 0;
        for (const envelope of queue) {
          if (!verifyRelayEnvelope(envelope, did)) return true;
          bytes += Buffer.byteLength(JSON.stringify(envelope));
          if (bytes > this.maxQueueBytesPerRecipient || bytes > this.maxEnvelopeBytes * queue.length)
            return true;
        }
        return queue.some((envelope) => Buffer.byteLength(JSON.stringify(envelope)) > this.maxEnvelopeBytes);
      }) ||
      this.invalidAgentSnapshot(snapshot, agentExpiry)
    )
      throw new Error('INVALID_RELAY_SNAPSHOT');
    this.queues = new Map();
    for (const [did, envelopes] of structuredClone(snapshot.queues)) {
      this.queues.set(
        did,
        envelopes.map((envelope) => ({
          envelope,
          bytes: Buffer.byteLength(JSON.stringify(envelope)),
          expiresAt:
            envelopeExpiry.get(envelope.payload.envelopeId) ?? this.now() + this.envelopeTtlMs,
        })),
      );
    }
    this.seen = new Map(
      snapshot.seen.map((id) => [id, seenExpiry.get(id) ?? this.now() + this.seenTtlMs]),
    );
    this.authSeen = new Map(
      (snapshot.authSeen ?? []).map((id) => [id, authExpiry.get(id) ?? this.now() + this.authSeenTtlMs]),
    );
    this.agents.clear();
    this.agentExpiry.clear();
    for (const card of snapshot.agents) {
      const copy = structuredClone(card);
      const key = agentRegistryKey(copy.payload.ownerDid, copy.payload.agentDid);
      this.agents.set(key, copy);
      const cardExpiresAt = Date.parse(copy.payload.expiresAt);
      this.agentExpiry.set(
        key,
        agentExpiry.get(key) ?? Math.min(this.now() + this.agentCardTtlMs, cardExpiresAt),
      );
    }
    this.version++;
  }
  /** Reject snapshots that would resurrect an expired, duplicate, or unsigned card. */
  private invalidAgentSnapshot(snapshot: RelaySnapshot, agentExpiry: Map<string, number>): boolean {
    const seen = new Set<string>();
    for (const card of snapshot.agents) {
      const key = agentRegistryKey(card.payload.ownerDid, card.payload.agentDid);
      const stored = agentExpiry.get(key);
      const effective =
        stored ?? Math.min(this.now() + this.agentCardTtlMs, Date.parse(card.payload.expiresAt));
      if (seen.has(key) || !verifySignedAgentCard(card, this.now()) || !(effective > this.now()))
        return true;
      seen.add(key);
    }
    return false;
  }
  discover(): SignedAgentCard[] {
    this.evictExpired();
    return structuredClone([...this.agents.values()]);
  }
  register(card: SignedAgentCard): void {
    if (!verifySignedAgentCard(card, this.now())) throw new Error('INVALID_AGENT_CARD');
    this.evictExpired();
    // A different ownerDid is a different registry entry and cannot squat this agentDid.
    const key = agentRegistryKey(card.payload.ownerDid, card.payload.agentDid);
    const old = this.agents.get(key);
    if (old && Date.parse(old.signature.signedAt) > Date.parse(card.signature.signedAt))
      throw new Error('AGENT_OWNER_OR_VERSION_MISMATCH');
    if (!old && this.agents.size >= this.maxAgents) throw new Error('RELAY_CAPACITY');
    const copy = structuredClone(card);
    const expiresAt = Math.min(this.now() + this.agentCardTtlMs, Date.parse(copy.payload.expiresAt));
    if (!(expiresAt > this.now())) throw new Error('INVALID_AGENT_CARD');
    this.agents.set(key, copy);
    this.agentExpiry.set(key, expiresAt);
    this.version++;
  }
}
export interface RelayAuthContext {
  expectedOrigin?: string;
  requireOrigin?: boolean;
}
export interface RelayRequestAuthOptions {
  allowQueryAuth?: boolean;
  requireOrigin?: boolean;
  allowUnboundRelayAuth?: boolean;
}
export interface RelayFetchOptions extends RelayRequestAuthOptions {
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
function relayJson(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: relayHttpHeaders('json') });
}
/**
 * Protocol codes the relay may place in an HTTP or WebSocket error body.
 * A thrown message is returned only when it matches one of these strings exactly.
 * Names that the live relay does not throw today stay listed so a later
 * constant code is not replaced by RELAY_INTERNAL_ERROR.
 */
export const KNOWN_RELAY_ERROR_CODES = [
  'INVALID_ENVELOPE',
  'INVALID_SIGNED_ENVELOPE',
  'ENVELOPE_EXPIRED',
  'REPLAYED_ENVELOPE',
  'DUPLICATE_ENVELOPE_ID',
  'ENVELOPE_TOO_LARGE',
  'RELAY_CAPACITY',
  'RELAY_QUEUE_FULL',
  'QUEUE_BYTES_EXCEEDED',
  'QUEUE_LIMIT_EXCEEDED',
  'RELAY_BYTE_BUDGET_EXCEEDED',
  'SENDER_QUOTA_EXCEEDED',
  'INVALID_RECIPIENT_DID',
  'MISSING_RECIPIENT_DID',
  'INVALID_DID',
  'RELAY_TAMPERING_DETECTED',
  'INVALID_AGENT_CARD',
  'AGENT_CARD_EXPIRED',
  'AGENT_CARD_EXPIRY_TOO_LONG',
  'AGENT_CARD_DELEGATION_REQUIRED',
  'AGENT_DELEGATION_REQUIRED',
  'AGENT_CARD_DELEGATION_INVALID',
  'AGENT_CARD_TOO_LARGE',
  'AGENT_REGISTRY_FULL',
  'AGENT_CARD_TTL_INVALID',
  'AGENT_OWNER_OR_VERSION_MISMATCH',
  'NO_AGENT_REGISTERED',
  'RELAY_UNAUTHORIZED',
  'RELAY_AUTH_REQUIRED',
  'RELAY_AUTH_INVALID',
  'RELAY_AUTH_SIGNATURE_INVALID',
  'RELAY_AUTH_RECIPIENT_MISMATCH',
  'RELAY_AUTH_ACTION_MISMATCH',
  'RELAY_AUTH_EXPIRED',
  'RELAY_AUTH_FUTURE_ISSUED_AT',
  'RELAY_AUTH_REPLAYED',
  'RELAY_AUTH_NONCE_INVALID',
  'RELAY_AUTH_ORIGIN_REQUIRED',
  'RELAY_AUTH_ORIGIN_MISMATCH',
  'RELAY_QUERY_AUTH_DISABLED',
  'INVALID_RELAY_ORIGIN',
  'RATE_LIMITED',
  'RATE_LIMITER_UNAVAILABLE',
  'PAYLOAD_TOO_LARGE',
  'BODY_TOO_LARGE',
  'MISSING_BODY',
  'INVALID_JSON',
  'INVALID_UNICODE',
  'INVALID_LIMIT',
  'INVALID_RELAY_LIMIT',
  'INVALID_TIMEOUT',
  'INVALID_WAIT',
  'MISSING_ENVELOPE_ID',
  'UNSUPPORTED_METHOD',
  'NOT_FOUND',
  'WEBSOCKET_UPGRADE_REQUIRED',
  'INVALID_REQUEST',
  'INVALID_RELAY_SNAPSHOT',
  'RELAY_INTERNAL_ERROR',
] as const;
const KNOWN_RELAY_ERROR_CODE_SET: ReadonlySet<string> = new Set(KNOWN_RELAY_ERROR_CODES);
/** HTTP status for each public code. Anything else is 500 RELAY_INTERNAL_ERROR. */
const RELAY_ERROR_STATUS: Readonly<Record<string, number>> = {
  INVALID_ENVELOPE: 400,
  INVALID_SIGNED_ENVELOPE: 400,
  ENVELOPE_EXPIRED: 400,
  REPLAYED_ENVELOPE: 400,
  DUPLICATE_ENVELOPE_ID: 400,
  ENVELOPE_TOO_LARGE: 400,
  RELAY_CAPACITY: 400,
  RELAY_QUEUE_FULL: 400,
  INVALID_RECIPIENT_DID: 400,
  MISSING_RECIPIENT_DID: 400,
  INVALID_DID: 400,
  RELAY_TAMPERING_DETECTED: 400,
  INVALID_AGENT_CARD: 400,
  AGENT_CARD_EXPIRED: 400,
  AGENT_CARD_EXPIRY_TOO_LONG: 400,
  AGENT_CARD_DELEGATION_REQUIRED: 400,
  AGENT_DELEGATION_REQUIRED: 400,
  AGENT_CARD_DELEGATION_INVALID: 400,
  AGENT_CARD_TOO_LARGE: 400,
  AGENT_REGISTRY_FULL: 400,
  AGENT_CARD_TTL_INVALID: 400,
  AGENT_OWNER_OR_VERSION_MISMATCH: 400,
  INVALID_RELAY_ORIGIN: 400,
  PAYLOAD_TOO_LARGE: 400,
  BODY_TOO_LARGE: 400,
  MISSING_BODY: 400,
  INVALID_JSON: 400,
  INVALID_UNICODE: 400,
  INVALID_LIMIT: 400,
  INVALID_RELAY_LIMIT: 400,
  INVALID_TIMEOUT: 400,
  INVALID_WAIT: 400,
  MISSING_ENVELOPE_ID: 400,
  UNSUPPORTED_METHOD: 400,
  WEBSOCKET_UPGRADE_REQUIRED: 400,
  INVALID_REQUEST: 400,
  INVALID_RELAY_SNAPSHOT: 400,
  RELAY_UNAUTHORIZED: 401,
  RELAY_AUTH_REQUIRED: 401,
  RELAY_AUTH_INVALID: 401,
  RELAY_AUTH_SIGNATURE_INVALID: 401,
  RELAY_AUTH_RECIPIENT_MISMATCH: 401,
  RELAY_AUTH_ACTION_MISMATCH: 401,
  RELAY_AUTH_EXPIRED: 401,
  RELAY_AUTH_FUTURE_ISSUED_AT: 401,
  RELAY_AUTH_REPLAYED: 401,
  RELAY_AUTH_NONCE_INVALID: 401,
  RELAY_AUTH_ORIGIN_REQUIRED: 401,
  RELAY_AUTH_ORIGIN_MISMATCH: 401,
  RELAY_QUERY_AUTH_DISABLED: 401,
  QUEUE_BYTES_EXCEEDED: 429,
  QUEUE_LIMIT_EXCEEDED: 429,
  RELAY_BYTE_BUDGET_EXCEEDED: 429,
  SENDER_QUOTA_EXCEEDED: 429,
  RATE_LIMITED: 429,
  NOT_FOUND: 404,
  NO_AGENT_REGISTERED: 404,
  RATE_LIMITER_UNAVAILABLE: 503,
  RELAY_INTERNAL_ERROR: 500,
};
if (
  KNOWN_RELAY_ERROR_CODE_SET.size !== KNOWN_RELAY_ERROR_CODES.length ||
  KNOWN_RELAY_ERROR_CODES.some((code) => RELAY_ERROR_STATUS[code] === undefined) ||
  Object.keys(RELAY_ERROR_STATUS).some((code) => !KNOWN_RELAY_ERROR_CODE_SET.has(code))
)
  throw new Error('RELAY_ERROR_CATALOG_MISMATCH');
function malformedClientCode(error: unknown): string | undefined {
  if (error instanceof SyntaxError || error instanceof URIError) return 'INVALID_REQUEST';
  if (error instanceof TypeError && error.message === 'Invalid URL') return 'INVALID_REQUEST';
  return undefined;
}
/**
 * Public error code for an untrusted caller.
 * Parser and URL failures become INVALID_REQUEST. Any other message is returned
 * only when it is an allowlisted code; otherwise the result is the fallback
 * when that fallback is itself allowlisted, or RELAY_INTERNAL_ERROR.
 */
export function sanitizeRelayErrorCode(error: unknown, fallback = 'RELAY_INTERNAL_ERROR'): string {
  const raw =
    malformedClientCode(error) ?? (error instanceof Error ? error.message : String(error));
  if (KNOWN_RELAY_ERROR_CODE_SET.has(raw)) return raw;
  return KNOWN_RELAY_ERROR_CODE_SET.has(fallback) ? fallback : 'RELAY_INTERNAL_ERROR';
}
export interface MappedRelayError {
  status: number;
  error: string;
}
/** Status and public code for one relay failure. Internal detail never leaves this function. */
export function mapRelayError(error: unknown): MappedRelayError {
  const code = sanitizeRelayErrorCode(error);
  return { status: RELAY_ERROR_STATUS[code] ?? 500, error: code };
}
/** Auth failures that must stay 401s with a stable error code. */
export function relayAuthFailure(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = sanitizeRelayErrorCode(error);
  return RELAY_ERROR_STATUS[code] === 401 ? code : undefined;
}
export function relayErrorResponse(error: unknown, relay?: InMemoryRelay): Response {
  const mapped = mapRelayError(error);
  if (mapped.status === 429) {
    return Response.json(
      { error: mapped.error },
      {
        status: 429,
        headers: {
          ...relayHttpHeaders('json'),
          'retry-after': String(relay?.retryAfterSeconds() ?? 60),
        },
      },
    );
  }
  return relayJson({ error: mapped.error }, mapped.status);
}
/**
 * Bearer credential for a relay request.
 * `?auth=` is ignored unless `allowQueryAuth` is set, so tokens do not land in
 * access logs, proxy logs, or Referer headers by default.
 */
export function extractRelayAuthToken(
  request: Request,
  options: { allowQueryAuth?: boolean } = {},
  url = new URL(request.url),
): string | undefined {
  if (url.searchParams.has('auth') && options.allowQueryAuth !== true)
    throw new Error('RELAY_QUERY_AUTH_DISABLED');
  return (
    request.headers.get('authorization')?.match(/^Bearer (\S+)$/i)?.[1] ??
    request.headers.get('x-acp-relay-auth') ??
    (options.allowQueryAuth === true ? (url.searchParams.get('auth') ?? undefined) : undefined)
  );
}
export function relayRequestToken(
  request: Request,
  url = new URL(request.url),
  options?: { allowQueryAuth?: boolean },
): string | undefined {
  return extractRelayAuthToken(request, options, url);
}
export function relayAuthContext(
  request: Request,
  relay: InMemoryRelay,
  options: RelayRequestAuthOptions = {},
): RelayAuthContext {
  const requireOrigin =
    options.requireOrigin ??
    !(options.allowUnboundRelayAuth === true || relay.allowUnboundRelayAuth);
  return { expectedOrigin: new URL(request.url).origin, requireOrigin };
}
export type DurableLongPoll =
  | { mode: 'response'; response: Response }
  | {
      mode: 'wait';
      recipient: string;
      waitMs: number;
      receive: () => SignedEnvelope | undefined;
    };
/**
 * Authenticate a long-poll and pop envelopes that are already queued.
 * The caller waits outside the durable-object lock when the inbox is empty.
 */
export function beginDurableLongPoll(
  relay: InMemoryRelay,
  request: Request,
  auth: RelayRequestAuthOptions = {},
): DurableLongPoll {
  try {
    const url = new URL(request.url);
    const recipient = url.searchParams.get('recipient') ?? '';
    resolveDid(recipient);
    const ms = Number(url.searchParams.get('waitMs'));
    if (!url.searchParams.has('waitMs') || !Number.isFinite(ms) || ms < 0)
      throw new Error('INVALID_WAIT');
    const token = extractRelayAuthToken(request, auth, url);
    // A request that is already aborted must not authenticate or pop.
    if (request.signal.aborted) return { mode: 'response', response: relayJson({ envelopes: [] }) };
    const receive = relay.openInbox(
      recipient,
      token,
      'receive',
      relayAuthContext(request, relay, auth),
    );
    if (request.signal.aborted) return { mode: 'response', response: relayJson({ envelopes: [] }) };
    const buffered: SignedEnvelope[] = [];
    let envelope: SignedEnvelope | undefined;
    while ((envelope = receive())) buffered.push(envelope);
    if (buffered.length) return { mode: 'response', response: relayJson({ envelopes: buffered }) };
    return { mode: 'wait', recipient, waitMs: Math.min(ms, 30000), receive };
  } catch (error) {
    return { mode: 'response', response: relayErrorResponse(error, relay) };
  }
}
export function createRelayFetchHandler(
  options: RelayFetchOptions = {},
): (request: Request) => Promise<Response> {
  const relay = options.relay ?? new InMemoryRelay();
  const authOptions: RelayRequestAuthOptions = {
    allowQueryAuth: options.allowQueryAuth,
    requireOrigin: options.requireOrigin,
    allowUnboundRelayAuth: options.allowUnboundRelayAuth,
  };
  const json = (value: unknown, status = 200) =>
    Response.json(value, { status, headers: relayHttpHeaders('json') });
  const empty = (status: 202 | 204) =>
    new Response(null, { status, headers: relayHttpHeaders('empty') });
  async function body(request: Request): Promise<unknown> {
    const limit = relay.maxEnvelopeBytes;
    if (Number(request.headers.get('content-length')) > limit) throw new Error('BODY_TOO_LARGE');
    const reader = request.body?.getReader();
    if (!reader) throw new Error('MISSING_BODY');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
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
      relay.evictExpired();
      const url = new URL(request.url),
        path = canonicalRelayPath(url.pathname);
      if (request.method === 'GET' && path === '/health') return json({ status: 'ok' });
      if (request.method === 'POST' && path === '/agents') {
        relay.register((await body(request)) as SignedAgentCard);
        return json({ registered: true }, 201);
      }
      if (request.method === 'GET' && path === '/agents') {
        const ownerDid = url.searchParams.get('ownerDid');
        const agentDid = url.searchParams.get('agentDid');
        let cards = [...relay.agents.values()];
        if (ownerDid !== null) cards = cards.filter((card) => card.payload.ownerDid === ownerDid);
        if (agentDid !== null) cards = cards.filter((card) => card.payload.agentDid === agentDid);
        return json(cards);
      }
      if (request.method === 'GET' && path.startsWith('/agents/')) {
        const segments = path
          .slice('/agents/'.length)
          .split('/')
          .filter((segment) => segment.length > 0)
          .map((segment) => decodeURIComponent(segment));
        const card =
          segments.length === 2
            ? relay.agents.get(agentRegistryKey(segments[0]!, segments[1]!))
            : segments.length === 1
              ? selectAgentCard(relay.agents.values(), segments[0]!)
              : undefined;
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
      if (
        request.method === 'DELETE' &&
        (path === '/envelopes' || path.startsWith('/envelopes/'))
      ) {
        const envelopeId = path.startsWith('/envelopes/')
          ? decodeURIComponent(path.slice('/envelopes/'.length))
          : (url.searchParams.get('id') ?? '');
        if (!envelopeId) throw new Error('MISSING_ENVELOPE_ID');
        const recipient = url.searchParams.get('recipient') ?? '';
        resolveDid(recipient);
        const removed = relay.acknowledge(
          recipient,
          envelopeId,
          extractRelayAuthToken(request, authOptions, url),
          relayAuthContext(request, relay, authOptions),
        );
        return removed ? empty(204) : json({ error: 'NOT_FOUND' }, 404);
      }
      if (request.method === 'GET' && ['/envelopes', '/stream'].includes(path)) {
        const recipient = url.searchParams.get('recipient') ?? '';
        resolveDid(recipient);
        const ms = url.searchParams.has('waitMs')
          ? Number(url.searchParams.get('waitMs'))
          : undefined;
        if (ms !== undefined && (!Number.isFinite(ms) || ms < 0)) throw new Error('INVALID_WAIT');
        const token = extractRelayAuthToken(request, authOptions, url);
        const receive = relay.openInbox(
          recipient,
          token,
          path === '/stream' ? 'stream' : 'receive',
          relayAuthContext(request, relay, authOptions),
        );
        if (path === '/stream') {
          let stop = () => {};
          let flush = () => {};
          // One queued chunk keeps an unread stream from draining the relay queue.
          const stream = new ReadableStream<Uint8Array>(
            {
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
                flush = () => {
                  if (closed) return;
                  try {
                    let envelope;
                    // Leave envelopes in the bounded recipient queue until the client pulls.
                    while (
                      controller.desiredSize !== null &&
                      controller.desiredSize > 0 &&
                      (envelope = receive())
                    )
                      controller.enqueue(
                        encoder.encode('data: ' + JSON.stringify(envelope) + '\n\n'),
                      );
                  } catch {
                    close();
                  }
                };
                const off = relay.subscribe(recipient, flush);
                const heartbeat = setInterval(() => {
                  if (!closed && controller.desiredSize !== null && controller.desiredSize > 0)
                    controller.enqueue(encoder.encode(': heartbeat\n\n'));
                }, 15000);
                stop = close;
                request.signal.addEventListener('abort', close, { once: true });
                controller.enqueue(encoder.encode(': connected\n\n'));
                flush();
                if (request.signal.aborted) close();
              },
              pull() {
                flush();
              },
              cancel() {
                stop();
              },
            },
            { highWaterMark: 1 },
          );
          return new Response(stream, { headers: relayHttpHeaders('sse') });
        }
        if (!url.searchParams.has('waitMs')) {
          const e = receive();
          return e ? json(e) : empty(204);
        }
        // An already-aborted poll must not pop envelopes that are still queued.
        if (request.signal.aborted) return json({ envelopes: [] });
        const ready: SignedEnvelope[] = [];
        let queued: SignedEnvelope | undefined;
        while ((queued = receive())) ready.push(queued);
        if (!ready.length) {
          await relay.wait(recipient, Math.min(ms!, 30000), request.signal);
          if (request.signal.aborted) return json({ envelopes: [] });
          while ((queued = receive())) ready.push(queued);
        }
        return json({ envelopes: ready });
      }
      return json({ error: 'NOT_FOUND' }, 404);
    } catch (error) {
      return relayErrorResponse(error, relay);
    }
  };
}
