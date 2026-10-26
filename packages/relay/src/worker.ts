// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { createRelayFetchHandler, InMemoryRelay } from './fetch.js';
import type { RelaySnapshot } from './fetch.js';
interface DurableState {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    delete?(key: string): Promise<unknown>;
  };
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}
/** Durable storage preserves queue, registry and replay IDs across isolate restarts. */
export class RelayDurableObject {
  private relay = new InMemoryRelay();
  private handler = createRelayFetchHandler({ relay: this.relay });
  private ready: Promise<void>;
  /** Serializes handler mutation, snapshot write, and rollback for every request. */
  private turn: Promise<unknown> = Promise.resolve();
  private persistedVersion = 0;
  private committedSnapshot?: RelaySnapshot;
  private stored?: { generation: string; count: number };
  constructor(private state: DurableState) {
    this.ready = state.blockConcurrencyWhile(async () => {
      this.stored = await state.storage.get<{ generation: string; count: number }>('relay-head');
      if (this.stored) {
        const chunks = await Promise.all(
          Array.from({ length: this.stored.count }, (_, i) =>
            state.storage.get<Uint8Array>('relay:' + this.stored!.generation + ':' + i),
          ),
        );
        if (chunks.some((c) => !c)) throw new Error('INCOMPLETE_RELAY_STORAGE');
        this.relay.restore(
          JSON.parse(Buffer.concat(chunks as Uint8Array[]).toString('utf8')) as RelaySnapshot,
        );
      }
      this.persistedVersion = this.relay.mutationVersion;
      this.committedSnapshot = this.relay.snapshot();
    });
  }
  /** Queue one turn. A rejection stays on that turn and does not poison the next one. */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.turn.catch(() => undefined).then(work);
    this.turn = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
  /** Persist the current relay. Caller must already hold the request turn. */
  private async writeSnapshot(): Promise<void> {
    if (this.persistedVersion === this.relay.mutationVersion) return;
    const version = this.relay.mutationVersion,
      snapshot = Buffer.from(JSON.stringify(this.relay.snapshot())),
      rollback = this.committedSnapshot;
    const generation = randomUUID(),
      count = Math.ceil(snapshot.length / 64000),
      old = this.stored;
    let committed = false;
    try {
      // Stay below the Durable Object per-value storage limit. Publish the
      // head only after all chunks exist, so eviction never exposes a partial snapshot.
      for (let i = 0; i < count; i++)
        await this.state.storage.put(
          'relay:' + generation + ':' + i,
          new Uint8Array(snapshot.subarray(i * 64000, (i + 1) * 64000)),
        );
      await this.state.storage.put('relay-head', { generation, count });
      this.stored = { generation, count };
      this.persistedVersion = version;
      this.committedSnapshot = JSON.parse(snapshot.toString('utf8')) as RelaySnapshot;
      committed = true;
      if (old && this.state.storage.delete)
        for (let i = 0; i < old.count; i++)
          await this.state.storage.delete('relay:' + old.generation + ':' + i);
    } catch (error) {
      // A failed put/delete must not leave memory ahead of the last durable snapshot.
      if (!committed && rollback && this.relay.mutationVersion === version)
        this.relay.restore(rollback);
      throw error;
    }
  }
  /** Later SSE pulls persist after the request turn has released this lock. */
  private persist(): Promise<void> {
    return this.enqueue(() => this.writeSnapshot());
  }
  async fetch(request: Request): Promise<Response> {
    await this.ready;
    return this.enqueue(() => this.handle(request));
  }
  private async handle(request: Request): Promise<Response> {
    const response = await this.handler(request);
    const path = new URL(request.url).pathname;
    if (!response.ok) return response;
    if (request.method === 'GET' && path === '/stream' && response.body) {
      await this.writeSnapshot();
      const reader = response.body.getReader();
      const persist = () => this.persist();
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            const { value, done } = await reader.read();
            if (done) controller.close();
            else {
              await persist();
              controller.enqueue(value);
            }
          },
          async cancel() {
            await reader.cancel();
          },
        }),
        { status: response.status, headers: response.headers },
      );
    }
    if (
      (request.method === 'POST' && ['/agents', '/envelopes'].includes(path)) ||
      (request.method === 'GET' && path === '/envelopes')
    )
      await this.writeSnapshot();
    return response;
  }
}
const localHandler = createRelayFetchHandler();
interface RelayNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}
export default {
  fetch(request: Request, env?: { RELAY?: RelayNamespace }): Promise<Response> {
    return env?.RELAY
      ? env.RELAY.get(env.RELAY.idFromName('acp-relay')).fetch(request)
      : localHandler(request);
  },
};
