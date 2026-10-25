// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { createRelayFetchHandler, InMemoryRelay } from './fetch.js';
import type { RelaySnapshot } from './fetch.js';
interface DurableState {
  storage: { get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void>; delete?(key: string): Promise<unknown> };
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}
/** Durable storage preserves queue, registry and replay IDs across isolate restarts. */
export class RelayDurableObject {
  private relay = new InMemoryRelay(); private handler = createRelayFetchHandler({ relay: this.relay });
  private ready: Promise<void>; private writes = Promise.resolve();
  private stored?: { generation: string; count: number };
  constructor(private state: DurableState) {
    this.ready = state.blockConcurrencyWhile(async () => {
      this.stored = await state.storage.get<{ generation: string; count: number }>('relay-head');
      if (this.stored) {
        const chunks = await Promise.all(Array.from({ length: this.stored.count }, (_, i) => state.storage.get<Uint8Array>('relay:' + this.stored!.generation + ':' + i)));
        if (chunks.some(c => !c)) throw new Error('INCOMPLETE_RELAY_STORAGE');
        this.relay.restore(JSON.parse(Buffer.concat(chunks as Uint8Array[]).toString('utf8')) as RelaySnapshot);
      }
    });
  }
  async fetch(request: Request): Promise<Response> {
    await this.ready; const response = await this.handler(request);
    const persist = () => {
      const snapshot = Buffer.from(JSON.stringify(this.relay.snapshot()));
      this.writes = this.writes.then(async () => {
        const generation = randomUUID(), count = Math.ceil(snapshot.length / 64000), old = this.stored;
        // Stay below the Durable Object per-value storage limit. Publish the
        // head only after all chunks exist, so eviction never exposes a partial snapshot.
        for (let i = 0; i < count; i++) await this.state.storage.put('relay:' + generation + ':' + i, new Uint8Array(snapshot.subarray(i * 64000, (i + 1) * 64000)));
        await this.state.storage.put('relay-head', { generation, count }); this.stored = { generation, count };
        if (old && this.state.storage.delete) for (let i = 0; i < old.count; i++) await this.state.storage.delete('relay:' + old.generation + ':' + i);
      }); return this.writes;
    };
    if (new URL(request.url).pathname === '/stream' && response.body) {
      const reader = response.body.getReader();
      return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) { const { value, done } = await reader.read(); if (done) controller.close(); else { await persist(); controller.enqueue(value); } },
        async cancel() { await reader.cancel(); }
      }), { status: response.status, headers: response.headers });
    }
    await persist(); return response;
  }
}
const localHandler = createRelayFetchHandler();
interface RelayNamespace { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } }
export default {
  fetch(request: Request, env?: { RELAY?: RelayNamespace }): Promise<Response> {
    return env?.RELAY ? env.RELAY.get(env.RELAY.idFromName('acp-relay')).fetch(request) : localHandler(request);
  }
};
