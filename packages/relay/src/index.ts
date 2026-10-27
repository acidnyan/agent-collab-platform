// SPDX-License-Identifier: Apache-2.0
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { verifyEnvelope, createRelayAuthToken } from '@acp/core';
import type { SignedEnvelope, KeyPair, RelayAuthAction } from '@acp/core';
import {
  DEFAULT_MAX_ENVELOPE_BYTES,
  InMemoryRelay,
  createRelayFetchHandler,
  relayHttpHeaders,
} from './fetch.js';
export * from './fetch.js';
export {
  createSignedAgentCard,
  verifySignedAgentCard,
  toA2AAgentCard,
  createInviteToken,
  parseAndVerifyInviteToken,
} from '@acp/core';
export async function startLocalRelay(
  options: { port?: number; host?: string; tamper?: (e: SignedEnvelope) => SignedEnvelope } = {},
) {
  const relay = new InMemoryRelay(options.tamper),
    handler = createRelayFetchHandler({ relay });
  const server = createServer(async (request, response) => {
    const controller = new AbortController();
    response.once('close', () => controller.abort());
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += (chunk as Buffer).length;
        if (size > DEFAULT_MAX_ENVELOPE_BYTES) throw new Error('BODY_TOO_LARGE');
        chunks.push(chunk as Buffer);
      }
      const result = await handler(
        new Request(new URL(request.url ?? '/', 'http://localhost'), {
          method: request.method,
          headers: Object.entries(request.headers).flatMap(([name, value]) =>
            value === undefined
              ? []
              : (Array.isArray(value) ? value : [value]).map((v) => [name, v] as [string, string]),
          ),
          ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
          signal: controller.signal,
        }),
      );
      const kind = result.headers.get('content-type')?.startsWith('text/event-stream')
        ? 'sse'
        : result.body == null
          ? 'empty'
          : 'json';
      response.writeHead(result.status, {
        ...Object.fromEntries(result.headers),
        ...relayHttpHeaders(kind),
      });
      if (!result.body) {
        response.end();
        return;
      }
      const reader = result.body.getReader();
      try {
        while (!response.destroyed && !response.writableEnded) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!response.write(value)) {
            // A disconnected client never emits drain. Close and error must unblock the write.
            if (response.destroyed || response.writableEnded) break;
            await new Promise<void>((resolve) => {
              const doneWriting = () => {
                response.off('drain', doneWriting);
                response.off('close', doneWriting);
                response.off('error', doneWriting);
                resolve();
              };
              response.once('drain', doneWriting);
              response.once('close', doneWriting);
              response.once('error', doneWriting);
              if (response.destroyed || response.writableEnded) doneWriting();
            });
            if (response.destroyed || response.writableEnded) break;
          }
        }
      } finally {
        await reader.cancel();
        if (!response.destroyed && !response.writableEnded) response.end();
      }
    } catch (e) {
      if (!response.headersSent) response.writeHead(400, relayHttpHeaders('json'));
      if (!response.destroyed) response.end(JSON.stringify({ error: String(e) }));
    }
  });
  server.requestTimeout = 10000;
  const wsServer = new WebSocketServer({ server, path: '/ws', maxPayload: 1048576 });
  wsServer.on('connection', (socket) => {
    let subscription: {
      disposed: boolean;
      timer?: ReturnType<typeof setTimeout>;
      stop: () => void;
    } = { disposed: true, stop: () => {} };
    const disposeSubscription = () => {
      subscription.disposed = true;
      if (subscription.timer !== undefined) {
        clearTimeout(subscription.timer);
        subscription.timer = undefined;
      }
      subscription.stop();
      subscription.stop = () => {};
    };
    socket.once('close', () => disposeSubscription());
    socket.on('message', (raw) => {
      try {
        const request = JSON.parse(raw.toString()) as {
          method: 'send' | 'receive' | 'subscribe' | 'unsubscribe';
          envelope?: SignedEnvelope;
          recipientDid?: string;
          authToken?: string;
          auth?: string;
        };
        if (request.method === 'send' && request.envelope) {
          relay.send(request.envelope);
          socket.send(JSON.stringify({ ok: true }));
        } else if (request.method === 'receive' && request.recipientDid) {
          const receive = relay.openInbox(request.recipientDid, request.authToken ?? request.auth);
          socket.send(JSON.stringify({ envelope: receive() ?? null }));
        } else if (request.method === 'subscribe' && request.recipientDid) {
          const did = request.recipientDid,
            receive = relay.openInbox(did, request.authToken ?? request.auth, 'subscribe');
          disposeSubscription();
          const current: {
            disposed: boolean;
            timer?: ReturnType<typeof setTimeout>;
            stop: () => void;
          } = { disposed: false, stop: () => {} };
          subscription = current;
          const flush = () => {
            if (current.disposed) return;
            let envelope;
            // A slow socket must not pull the recipient queue ahead of maxQueueSize.
            while (
              !current.disposed &&
              socket.readyState === WebSocket.OPEN &&
              socket.bufferedAmount < 1048576 &&
              (envelope = receive())
            )
              socket.send(JSON.stringify({ envelope }));
            if (
              !current.disposed &&
              socket.readyState === WebSocket.OPEN &&
              socket.bufferedAmount >= 1048576
            ) {
              if (current.timer !== undefined) clearTimeout(current.timer);
              current.timer = setTimeout(() => {
                current.timer = undefined;
                flush();
              }, 20);
            }
          };
          current.stop = relay.subscribe(did, flush);
          flush();
        } else if (request.method === 'unsubscribe') {
          disposeSubscription();
        } else throw new Error('INVALID_REQUEST');
      } catch (e) {
        socket.send(
          JSON.stringify({
            error:
              e instanceof Error && e.message === 'RELAY_UNAUTHORIZED'
                ? 'RELAY_UNAUTHORIZED'
                : String(e),
          }),
        );
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('RELAY_BIND');
  const hostname = address.address.includes(':') ? '[' + address.address + ']' : address.address;
  return {
    relay,
    url: 'http://' + hostname + ':' + address.port,
    wsUrl: 'ws://' + hostname + ':' + address.port + '/ws',
    close: async () => {
      for (const client of wsServer.clients) client.terminate();
      await new Promise<void>((resolve) => wsServer.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    },
  };
}
export type RelayAuthSource =
  | KeyPair
  | ((recipientDid: string, action: RelayAuthAction) => string | Promise<string>);
class RelayCredentials {
  private recipientKeys = new Map<string, KeyPair>();
  constructor(private authSource?: RelayAuthSource) {}
  setRecipientKey(key: KeyPair): this {
    this.recipientKeys.set(key.did, key);
    return this;
  }
  protected async authToken(did: string, action: RelayAuthAction): Promise<string> {
    const key = this.recipientKeys.get(did);
    if (key) return createRelayAuthToken(key, { action });
    if (typeof this.authSource === 'function') return this.authSource(did, action);
    if (this.authSource?.did === did) return createRelayAuthToken(this.authSource, { action });
    throw new Error('RELAY_AUTH_REQUIRED');
  }
}
export interface RelayTransport {
  withRecipient?(key: KeyPair): RelayTransport;
  setRecipientKey?(key: KeyPair): unknown;
  send(envelope: SignedEnvelope): void | Promise<void>;
  receive(
    recipientDid: string,
    waitMs?: number,
    signal?: AbortSignal,
  ): SignedEnvelope | undefined | Promise<SignedEnvelope | undefined>;
  register?(card: import('@acp/core').SignedAgentCard): void | Promise<void>;
  discover?():
    | import('@acp/core').SignedAgentCard[]
    | Promise<import('@acp/core').SignedAgentCard[]>;
}
export class HttpRelayClient extends RelayCredentials implements RelayTransport {
  private buffered = new Map<string, SignedEnvelope[]>();
  readonly fetcher: typeof fetch;
  constructor(
    readonly url: string,
    fetcherOrKey: typeof fetch | KeyPair = fetch,
    authSource?: RelayAuthSource,
  ) {
    super(typeof fetcherOrKey === 'function' ? authSource : fetcherOrKey);
    this.fetcher = typeof fetcherOrKey === 'function' ? fetcherOrKey : fetch;
  }
  async send(envelope: SignedEnvelope): Promise<void> {
    const result = await this.fetcher(this.url + '/envelopes', {
      method: 'POST',
      body: JSON.stringify(envelope),
      headers: { 'content-type': 'application/json' },
    });
    if (!result.ok) throw new Error('RELAY_REJECTED: ' + (await result.text()));
  }
  async register(card: import('@acp/core').SignedAgentCard): Promise<void> {
    const r = await this.fetcher(this.url + '/agents', {
      method: 'POST',
      body: JSON.stringify(card),
      headers: { 'content-type': 'application/json' },
    });
    if (!r.ok) throw new Error('RELAY_REGISTRATION_REJECTED');
  }
  async discover(): Promise<import('@acp/core').SignedAgentCard[]> {
    const r = await this.fetcher(this.url + '/agents');
    if (!r.ok) throw new Error('DISCOVERY_FAILED');
    const cards = (await r.json()) as import('@acp/core').SignedAgentCard[];
    const { verifySignedAgentCard } = await import('@acp/core');
    if (!Array.isArray(cards) || cards.some((c) => !verifySignedAgentCard(c)))
      throw new Error('INVALID_AGENT_CARD');
    return cards;
  }
  async receive(
    recipientDid: string,
    waitMs?: number,
    signal?: AbortSignal,
  ): Promise<SignedEnvelope | undefined> {
    const queue = this.buffered.get(recipientDid) ?? [];
    if (queue.length) return queue.shift();
    const r = await this.fetcher(
      this.url +
        '/envelopes?recipient=' +
        encodeURIComponent(recipientDid) +
        (waitMs === undefined ? '' : '&waitMs=' + waitMs),
      {
        signal,
        headers: { authorization: 'Bearer ' + (await this.authToken(recipientDid, 'receive')) },
      },
    );
    if (r.status === 204) return;
    if (!r.ok) throw new Error('RELAY_REJECTED');
    const body = (await r.json()) as SignedEnvelope | { envelopes: SignedEnvelope[] };
    const values = 'envelopes' in body ? body.envelopes : [body];
    if (!Array.isArray(values) || values.some((e) => !verifyEnvelope(e, recipientDid)))
      throw new Error('RELAY_TAMPERING_DETECTED');
    this.buffered.set(recipientDid, values);
    return values.shift();
  }
}
/** Persistent SSE transport with a bounded per-recipient inbox. */
export class SseRelayClient extends HttpRelayClient {
  maxBufferBytes = 2 * 1024 * 1024;
  private streams = new Map<
    string,
    {
      controller: AbortController;
      queue: SignedEnvelope[];
      notify: Set<() => void>;
      error?: unknown;
      pump?: Promise<void>;
    }
  >();
  override async receive(
    recipientDid: string,
    waitMs = 30000,
    signal?: AbortSignal,
  ): Promise<SignedEnvelope | undefined> {
    signal?.throwIfAborted();
    let state = this.streams.get(recipientDid);
    if (!state) {
      state = { controller: new AbortController(), queue: [], notify: new Set() };
      this.streams.set(recipientDid, state);
      const current = state;
      current.pump = (async () => {
        try {
          for await (const e of this.stream(recipientDid, current.controller.signal)) {
            if (current.queue.length >= 1000) throw new Error('SSE_CAPACITY');
            current.queue.push(e);
            for (const notify of [...current.notify]) notify();
          }
          if (!current.controller.signal.aborted) throw new Error('SSE_CLOSED');
        } catch (error) {
          current.error = error;
          for (const notify of [...current.notify]) notify();
        }
      })();
    }
    if (state.queue.length) return state.queue.shift();
    if (state.error) throw state.error;
    const current = state;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        current.notify.delete(wake);
        signal?.removeEventListener('abort', abort);
      };
      const wake = () => {
          cleanup();
          resolve();
        },
        abort = () => {
          cleanup();
          reject(new Error('SSE_ABORTED'));
        };
      const timer = setTimeout(wake, Math.max(0, Math.min(waitMs, 30000)));
      current.notify.add(wake);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
    if (current.error) throw current.error;
    return current.queue.shift();
  }
  async close(): Promise<void> {
    const states = [...this.streams.values()];
    this.streams.clear();
    for (const state of states) state.controller.abort();
    await Promise.all(states.map((s) => s.pump));
  }
  async *stream(recipientDid: string, signal?: AbortSignal): AsyncGenerator<SignedEnvelope> {
    const r = await this.fetcher(
      this.url + '/stream?recipient=' + encodeURIComponent(recipientDid),
      {
        signal,
        headers: { authorization: 'Bearer ' + (await this.authToken(recipientDid, 'stream')) },
      },
    );
    if (!r.ok || !r.body) throw new Error('SSE_FAILED');
    const reader = r.body.getReader(),
      decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (Buffer.byteLength(buffer, 'utf8') > this.maxBufferBytes)
          throw new Error('SSE_BUFFER_OVERFLOW');
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          for (const line of frame.split('\n'))
            if (line.startsWith('data: ')) {
              const e = JSON.parse(line.slice(6)) as SignedEnvelope;
              if (!verifyEnvelope(e, recipientDid)) throw new Error('RELAY_TAMPERING_DETECTED');
              yield e;
            }
        }
      }
    } finally {
      await reader.cancel();
    }
  }
}
export class WebSocketRelayClient extends RelayCredentials {
  private socket: WebSocket;
  private pending = false;
  constructor(url: string, authSource?: RelayAuthSource) {
    super(authSource);
    this.socket = new WebSocket(url);
  }
  async ready(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
    });
  }
  private async request(body: unknown): Promise<{ error?: string; envelope?: SignedEnvelope }> {
    await this.ready();
    if (this.pending) throw new Error('CONCURRENT_RELAY_REQUEST');
    this.pending = true;
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.socket.removeListener('message', receive);
          reject(new Error('RELAY_TIMEOUT'));
        }, 5000);
        const receive = (raw: import('ws').RawData) => {
          clearTimeout(timer);
          try {
            const r = JSON.parse(raw.toString()) as { error?: string };
            r.error ? reject(new Error(r.error)) : resolve(r);
          } catch (e) {
            reject(e);
          }
        };
        this.socket.once('message', receive);
        this.socket.send(JSON.stringify(body));
      });
    } finally {
      this.pending = false;
    }
  }
  async send(envelope: SignedEnvelope): Promise<void> {
    await this.request({ method: 'send', envelope });
  }
  async receive(recipientDid: string): Promise<SignedEnvelope | undefined> {
    const r = await this.request({
      method: 'receive',
      recipientDid,
      authToken: await this.authToken(recipientDid, 'receive'),
    });
    if (r.envelope && !verifyEnvelope(r.envelope, recipientDid))
      throw new Error('RELAY_TAMPERING_DETECTED');
    return r.envelope ?? undefined;
  }
  async *subscribe(recipientDid: string, signal?: AbortSignal): AsyncGenerator<SignedEnvelope> {
    signal?.throwIfAborted();
    await this.ready();
    const authToken = await this.authToken(recipientDid, 'subscribe');
    if (this.pending) throw new Error('CONCURRENT_RELAY_REQUEST');
    this.pending = true;
    const queue: SignedEnvelope[] = [];
    let failure: unknown,
      wake = () => {};
    const receive = (raw: import('ws').RawData) => {
      try {
        const r = JSON.parse(raw.toString()) as { error?: string; envelope?: SignedEnvelope };
        if (r.error) throw new Error(r.error);
        if (!r.envelope || !verifyEnvelope(r.envelope, recipientDid))
          throw new Error('RELAY_TAMPERING_DETECTED');
        if (queue.length >= 1000) throw new Error('RELAY_CAPACITY');
        queue.push(r.envelope);
      } catch (e) {
        failure = e;
      }
      wake();
    };
    const close = () => {
        failure = new Error('RELAY_CLOSED');
        wake();
      },
      error = (e: Error) => {
        failure = e;
        wake();
      };
    const abort = () => wake();
    this.socket.on('message', receive);
    this.socket.once('close', close);
    this.socket.once('error', error);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      this.socket.send(JSON.stringify({ method: 'subscribe', recipientDid, authToken }));
      while (!signal?.aborted) {
        if (failure) throw failure;
        if (queue.length) {
          yield queue.shift()!;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
          if (queue.length || failure || signal?.aborted) resolve();
        });
      }
    } finally {
      this.socket.off('message', receive);
      this.socket.off('close', close);
      this.socket.off('error', error);
      signal?.removeEventListener('abort', abort);
      if (this.socket.readyState === WebSocket.OPEN)
        this.socket.send(JSON.stringify({ method: 'unsubscribe' }));
      this.pending = false;
    }
  }
  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      this.socket.once('close', resolve);
      this.socket.close();
    });
  }
}
