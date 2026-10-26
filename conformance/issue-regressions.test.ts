// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, writeFile, rm as rmDir } from 'node:fs/promises';
import { get, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import {
  createRelayAuthToken,
  createSignedAgentCard,
  generateKeyPair,
  signEnvelope,
} from '../packages/core/src/index.js';
import type { Json } from '../packages/core/src/index.js';
import { InMemoryRelay, createRelayFetchHandler } from '../packages/relay/src/fetch.js';
import { startLocalRelay } from '../packages/relay/src/index.js';
import { RelayDurableObject } from '../packages/relay/src/worker.js';
import {
  PolicyAutoApprovalProvider,
  RequesterClient,
  WorkerNode,
  buildTaskManifest,
} from '../packages/runtime/src/index.js';
import { ClaudeCodeAdapter, runCommand } from '../packages/adapters/src/command.js';
import type { AgentTaskContext } from '../packages/adapters/src/index.js';
import { runSandbox } from '../packages/sandbox/src/index.js';

const fsMock = vi.hoisted(() => ({
  failRm: false,
  calls: [] as unknown[][],
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      fsMock.calls.push(args);
      if (fsMock.failRm) {
        const error = new Error('EBUSY: resource busy or locked, rmdir') as NodeJS.ErrnoException;
        error.code = 'EBUSY';
        throw error;
      }
      return actual.rm(...args);
    },
  };
});

afterEach(() => {
  fsMock.failRm = false;
  fsMock.calls.length = 0;
});

describe('issue 8: sandbox temp directory cleanup', () => {
  async function probe(): Promise<Array<Record<string, unknown>>> {
    const results: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 3; i++) {
      try {
        results.push({
          case: 'echo-' + i,
          value: await runSandbox({
            code: 'return input;',
            input: { ok: true },
            timeoutMs: 2000,
            onTool: async () => null,
          }),
        });
      } catch (e) {
        results.push({ case: 'echo-' + i, error: e instanceof Error ? e.message : String(e) });
      }
    }
    for (const kind of ['timeout', 'cancel'] as const) {
      const controller = new AbortController();
      const timer =
        kind === 'cancel' ? setTimeout(() => controller.abort('synthetic cancel'), 100) : undefined;
      try {
        await runSandbox({
          code: 'while(true){}',
          timeoutMs: 200,
          signal: controller.signal,
          onTool: async () => null,
        });
        results.push({ case: kind, result: 'unexpected success' });
      } catch (e) {
        results.push({ case: kind, error: e instanceof Error ? e.message : String(e) });
      } finally {
        clearTimeout(timer);
      }
    }
    return results;
  }

  it('keeps echo, timeout, and cancel results when removing the work directory', async () => {
    const results = await probe();
    expect(results.map((row) => row.case)).toEqual([
      'echo-0',
      'echo-1',
      'echo-2',
      'timeout',
      'cancel',
    ]);
    for (const row of results.slice(0, 3)) expect(row.value).toEqual({ ok: true });
    expect(results[3]?.error).toBe('SANDBOX_TIMEOUT');
    expect(results[4]?.error).toBe('SANDBOX_HALTED: synthetic cancel');
    expect(JSON.stringify(results)).not.toContain('EBUSY');
    const cleanups = fsMock.calls.filter((args) => String(args[0]).includes('acp-task-'));
    expect(cleanups.length).toBeGreaterThan(0);
    for (const args of cleanups) {
      expect(args[1]).toMatchObject({
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
  });

  it('does not replace a successful sandbox result when fs.rm throws EBUSY', async () => {
    fsMock.failRm = true;
    await expect(
      runSandbox({
        code: 'return input;',
        input: { ok: true },
        timeoutMs: 2000,
        onTool: async () => null,
      }),
    ).resolves.toEqual({ ok: true });
  });
});

describe('issue 9: concurrent delegate to one worker', () => {
  it('settles both concurrent tasks instead of consuming the other task inbox', async () => {
    const relay = new InMemoryRelay();
    const owner = generateKeyPair();
    const adapter = {
      id: 'synthetic',
      name: 'Synthetic echo',
      skills: [],
      executeTask: async (context: { input: Json }): Promise<Json> => context.input,
    };
    const events: string[] = [];
    const worker = new WorkerNode({
      owner,
      relay,
      adapter,
      timeoutMs: 1500,
      approvalProvider: new PolicyAutoApprovalProvider(owner),
      onEvent: (event) => events.push(event),
    });
    const controller = new AbortController();
    const running = worker.start({ signal: controller.signal });
    async function delegate(label: string) {
      const key = generateKeyPair();
      const requester = new RequesterClient({
        owner: key,
        relay,
        timeoutMs: 1500,
        approvalProvider: new PolicyAutoApprovalProvider(key),
      });
      try {
        const result = await requester.delegate({
          to: worker.invite(),
          title: label,
          description: 'Synthetic test only',
          input: { label },
        });
        return { label, state: result.state };
      } catch (e) {
        return { label, error: e instanceof Error ? e.message : String(e) };
      }
    }
    const sequential = [await delegate('sequential-1'), await delegate('sequential-2')];
    const concurrent = await Promise.all([delegate('concurrent-1'), delegate('concurrent-2')]);
    controller.abort();
    worker.stop();
    await running;
    expect(sequential).toEqual([
      { label: 'sequential-1', state: 'SETTLED' },
      { label: 'sequential-2', state: 'SETTLED' },
    ]);
    expect(concurrent).toEqual([
      { label: 'concurrent-1', state: 'SETTLED' },
      { label: 'concurrent-2', state: 'SETTLED' },
    ]);
    expect(events.filter((event) => event === 'SETTLED')).toHaveLength(4);
  });
});

describe('issue 10: durable storage recovery', () => {
  it('retries put and delete after one transient storage failure', async () => {
    const results: Record<string, unknown> = {};
    for (const failure of ['put', 'delete'] as const) {
      const data = new Map<string, unknown>();
      let calls = 0;
      let fail = false;
      const state = {
        storage: {
          get: async <T>(key: string): Promise<T | undefined> => data.get(key) as T | undefined,
          put: async (key: string, value: unknown) => {
            calls++;
            if (fail && failure === 'put') {
              fail = false;
              throw new Error('SYNTHETIC_TRANSIENT_STORAGE');
            }
            data.set(key, value);
          },
          delete: async (key: string) => {
            calls++;
            if (fail && failure === 'delete') {
              fail = false;
              throw new Error('SYNTHETIC_TRANSIENT_STORAGE');
            }
            return data.delete(key);
          },
        },
        blockConcurrencyWhile: async <T>(fn: () => Promise<T>) => fn(),
      };
      const object = new RelayDurableObject(state);
      const owner = generateKeyPair();
      async function post(name: string) {
        const card = createSignedAgentCard(
          {
            name,
            agentDid: owner.did,
            relayEndpoint: 'https://relay.local',
            skills: [],
          },
          owner,
        );
        try {
          return (
            await object.fetch(
              new Request('https://relay.local/agents', {
                method: 'POST',
                body: JSON.stringify(card),
              }),
            )
          ).status;
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
      }
      const first = await post('baseline');
      fail = true;
      const failed = await post('transient failure');
      const before = calls;
      const retry = await post('storage recovered');
      const visible = (await (
        await object.fetch(new Request('https://relay.local/agents'))
      ).json()) as Array<{ payload: { name: string } }>;
      const restarted = new RelayDurableObject(state);
      const persisted = (await (
        await restarted.fetch(new Request('https://relay.local/agents'))
      ).json()) as Array<{ payload: { name: string } }>;
      results[failure] = {
        first,
        failed,
        retry,
        storageCallsAfterRecovery: calls - before,
        visible: visible.map((card) => card.payload.name),
        persisted: persisted.map((card) => card.payload.name),
      };
    }
    for (const failure of ['put', 'delete']) {
      const row = results[failure] as {
        first: number;
        failed: string;
        retry: number;
        storageCallsAfterRecovery: number;
        visible: string[];
        persisted: string[];
      };
      expect(row.first).toBe(201);
      expect(row.failed).toBe('SYNTHETIC_TRANSIENT_STORAGE');
      expect(row.retry).toBe(201);
      expect(row.storageCallsAfterRecovery).toBeGreaterThan(0);
      expect(row.visible).toEqual(['storage recovered']);
      expect(row.persisted).toEqual(['storage recovered']);
    }
  });
});

describe('issue 11: unread SSE backpressure', () => {
  it('does not accept more unread envelopes than maxQueueSize', async () => {
    const owner = generateKeyPair();
    const peer = generateKeyPair();
    const relay = new InMemoryRelay();
    const handler = createRelayFetchHandler({ relay });
    const response = await handler(
      new Request('https://relay.local/stream?recipient=' + encodeURIComponent(peer.did), {
        headers: {
          authorization: 'Bearer ' + createRelayAuthToken(peer, { action: 'stream' }),
        },
      }),
    );
    let sent = 0;
    let limit: unknown;
    for (let i = 0; i < 1002; i++) {
      try {
        relay.send(
          signEnvelope(
            {
              taskId: 'task_sseprobe',
              recipientDid: peer.did,
              seq: i,
              eventType: 'PING',
              payload: {},
            },
            owner,
          ),
        );
        sent++;
      } catch (error) {
        limit = error;
        break;
      }
    }
    const queued = relay.snapshot().queues.reduce((count, [, queue]) => count + queue.length, 0);
    expect(sent).toBe(relay.maxQueueSize);
    expect(queued).toBeLessThanOrEqual(relay.maxQueueSize);
    expect(queued).toBeGreaterThan(0);
    expect(limit).toBeInstanceOf(Error);
    expect((limit as Error).message).toBe('RELAY_CAPACITY');
    expect(response.body).toBeTruthy();
  });
});

describe('issue 12: spawn a .cjs binary with Node', () => {
  it('runs a .cjs binaryPath through runCommand and ClaudeCodeAdapter', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'acp-cjs-'));
    try {
      const script = join(dir, 'mock-claude.cjs');
      await writeFile(
        script,
        'let input="";process.stdin.on("data",b=>input+=b);process.stdin.on("end",()=>{' +
          'process.stdout.write(JSON.stringify({result:JSON.stringify({ok:true,echo:JSON.parse(input||"{}")}),usage:{input_tokens:1,output_tokens:1}}));' +
          '});\n',
        { mode: 0o700 },
      );
      const command = await runCommand({
        command: script,
        args: [],
        cwd: dir,
        env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
        input: '{"n":1}',
        signal: AbortSignal.timeout(5000),
        timeoutMs: 5000,
      });
      expect(JSON.parse(command.stdout)).toMatchObject({
        result: JSON.stringify({ ok: true, echo: { n: 1 } }),
      });
      const owner = generateKeyPair();
      const worker = generateKeyPair();
      const manifest = buildTaskManifest({
        ownerDid: owner.did,
        workerDid: worker.did,
        title: 'cjs',
        description: 'fixture',
      });
      const context: AgentTaskContext = {
        taskId: manifest.taskId,
        manifest,
        input: { label: 'claude' },
        workspaceDir: dir,
        signal: AbortSignal.timeout(5000),
        callTool: async () => {
          throw new Error('TOOL_DENIED');
        },
        reportUsage: () => {},
        reportIsolation: () => {},
      };
      const output = await new ClaudeCodeAdapter({ binaryPath: script }).executeTask(context);
      expect(output).toEqual({ ok: true, echo: expect.any(Object) });
    } finally {
      await rmDir(dir, { recursive: true, force: true });
    }
  });
});

describe('issue 14: concurrent delegate from one requester', () => {
  it('routes parallel responses to the matching task mailbox', async () => {
    const relay = new InMemoryRelay();
    const owner = generateKeyPair();
    const requesterKey = generateKeyPair();
    const worker = new WorkerNode({
      owner,
      relay,
      adapter: {
        id: 'synthetic',
        name: 'echo',
        skills: [],
        executeTask: async (context) => context.input,
      },
      timeoutMs: 1500,
      approvalProvider: new PolicyAutoApprovalProvider(owner),
    });
    const controller = new AbortController();
    const running = worker.start({ signal: controller.signal });
    const requester = new RequesterClient({
      owner: requesterKey,
      relay,
      timeoutMs: 1500,
      approvalProvider: new PolicyAutoApprovalProvider(requesterKey),
    });
    async function delegate(label: string) {
      try {
        const result = await requester.delegate({
          to: worker.invite(),
          title: label,
          description: 'synthetic',
          input: { label },
        });
        return { label, state: result.state };
      } catch (error) {
        return { label, error: error instanceof Error ? error.message : String(error) };
      }
    }
    try {
      const sequential = [await delegate('seq1'), await delegate('seq2')];
      const concurrent = await Promise.all([delegate('parallel1'), delegate('parallel2')]);
      expect(sequential).toEqual([
        { label: 'seq1', state: 'SETTLED' },
        { label: 'seq2', state: 'SETTLED' },
      ]);
      expect(concurrent).toEqual([
        { label: 'parallel1', state: 'SETTLED' },
        { label: 'parallel2', state: 'SETTLED' },
      ]);
    } finally {
      controller.abort();
      worker.stop();
      await running;
    }
  });

  it('routes parallel responses when two clients share the owner and relay', async () => {
    const relay = new InMemoryRelay();
    const owner = generateKeyPair();
    const requesterKey = generateKeyPair();
    const worker = new WorkerNode({
      owner,
      relay,
      adapter: {
        id: 'synthetic',
        name: 'echo',
        skills: [],
        executeTask: async (context) => context.input,
      },
      timeoutMs: 1500,
      approvalProvider: new PolicyAutoApprovalProvider(owner),
    });
    const controller = new AbortController();
    const running = worker.start({ signal: controller.signal });
    const clients = [0, 1].map(
      () =>
        new RequesterClient({
          owner: requesterKey,
          relay,
          timeoutMs: 1500,
          approvalProvider: new PolicyAutoApprovalProvider(requesterKey),
        }),
    );
    try {
      const concurrent = await Promise.all(
        clients.map(async (requester, index) => {
          const label = 'shared-' + index;
          const result = await requester.delegate({
            to: worker.invite(),
            title: label,
            description: 'synthetic',
            input: { label },
          });
          return { label, state: result.state };
        }),
      );
      expect(concurrent).toEqual([
        { label: 'shared-0', state: 'SETTLED' },
        { label: 'shared-1', state: 'SETTLED' },
      ]);
    } finally {
      controller.abort();
      worker.stop();
      await running;
    }
  });
});

describe('issue 15: websocket unsubscribe cancels a backpressured flush', () => {
  it('leaves the envelope queued after unsubscribe', async () => {
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const originalEmit = WebSocketServer.prototype.emit;
    let backpressured = true;
    WebSocketServer.prototype.emit = function (
      this: WebSocketServer,
      event: string | symbol,
      ...args: unknown[]
    ) {
      if (event === 'connection') {
        const serverSocket = args[0] as { bufferedAmount?: number };
        Object.defineProperty(serverSocket, 'bufferedAmount', {
          configurable: true,
          get: () => (backpressured ? 1048576 : 0),
        });
      }
      return originalEmit.apply(this, [event, ...args]);
    };
    const server = await startLocalRelay();
    const client = new WebSocket(server.wsUrl);
    const received: Array<{ envelope?: unknown }> = [];
    client.on('message', (data) => {
      received.push(JSON.parse(data.toString()) as { envelope?: unknown });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        client.once('open', () => resolve());
        client.once('error', reject);
      });
      const owner = generateKeyPair();
      const peer = generateKeyPair();
      client.send(
        JSON.stringify({
          method: 'subscribe',
          recipientDid: peer.did,
          authToken: createRelayAuthToken(peer, { action: 'subscribe' }),
        }),
      );
      await pause(50);
      client.send(JSON.stringify({ method: 'unsubscribe' }));
      await pause(50);
      backpressured = false;
      server.relay.send(
        signEnvelope(
          {
            taskId: 'task_unsubscribe',
            recipientDid: peer.did,
            seq: 0,
            eventType: 'PING',
            payload: {},
          },
          owner,
        ),
      );
      await pause(80);
      const receivedAfterUnsubscribe = received.filter((item) => item.envelope).length;
      const remainingRelayQueue = server.relay
        .snapshot()
        .queues.reduce((count, [, queue]) => count + queue.length, 0);
      expect(receivedAfterUnsubscribe).toBe(0);
      expect(remainingRelayQueue).toBe(1);
    } finally {
      client.terminate();
      await server.close();
      WebSocketServer.prototype.emit = originalEmit;
    }
  });
});

describe('issue 17: overlapping durable storage failure', () => {
  it('rolls back the failed envelope before the queued request is saved', async () => {
    const data = new Map<string, unknown>();
    let release: () => void = () => {};
    let started: () => void = () => {};
    let failFirst = true;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((_, reject) => {
      release = () => reject(new Error('SYNTHETIC_TRANSIENT_STORAGE'));
    });
    const state = {
      storage: {
        get: async <T>(key: string): Promise<T | undefined> => data.get(key) as T | undefined,
        put: async (key: string, value: unknown) => {
          if (failFirst) {
            failFirst = false;
            started();
            await gate;
          }
          data.set(key, value);
        },
        delete: async (key: string) => data.delete(key),
      },
      blockConcurrencyWhile: async <T>(fn: () => Promise<T>) => fn(),
    };
    const object = new RelayDurableObject(state);
    const owner = generateKeyPair();
    const peer = generateKeyPair();
    const envelopeFor = (taskId: string, label: string) =>
      signEnvelope(
        {
          taskId,
          recipientDid: peer.did,
          seq: 0,
          eventType: 'PING',
          payload: { label },
        },
        owner,
      );
    const a = envelopeFor('task_overlap_a', 'A');
    const b = envelopeFor('task_overlap_b', 'B');
    async function post(envelope: ReturnType<typeof signEnvelope>) {
      try {
        const response = await object.fetch(
          new Request('https://relay.local/envelopes', {
            method: 'POST',
            body: JSON.stringify(envelope),
          }),
        );
        return { status: response.status, body: await response.text() };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    }
    const first = post(a);
    await entered;
    const second = post(b);
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    const requests = await Promise.all([first, second]);
    const retryA = await post(a);
    const restarted = new RelayDurableObject(state);
    const persisted: Array<{ status: number; label: string | null }> = [];
    for (let i = 0; i < 2; i++) {
      const response = await restarted.fetch(
        new Request('https://relay.local/envelopes?recipient=' + encodeURIComponent(peer.did), {
          headers: { authorization: 'Bearer ' + createRelayAuthToken(peer) },
        }),
      );
      persisted.push({
        status: response.status,
        label:
          response.status === 200
            ? ((await response.json()) as { payload: { payload: { label: string } } }).payload
                .payload.label
            : null,
      });
    }
    expect(requests).toEqual([{ error: 'SYNTHETIC_TRANSIENT_STORAGE' }, { status: 202, body: '' }]);
    expect(retryA).toEqual({ status: 202, body: '' });
    expect(persisted).toEqual([
      { status: 200, label: 'B' },
      { status: 200, label: 'A' },
    ]);
  });
});

describe('issue 18: http backpressure disconnect cancels the reader', () => {
  it('drops the drain listener and cancels the reader when write returns false', async () => {
    const results: Array<{
      forceBackpressure: boolean;
      readerCancelCalls: number;
      remainingDrainListeners: number;
    }> = [];
    for (const forceBackpressure of [false, true]) {
      let response: ServerResponse | undefined;
      let cancelled = 0;
      const originalWrite = ServerResponse.prototype.write;
      const originalReader = ReadableStream.prototype.getReader;
      ServerResponse.prototype.write = function (this: ServerResponse) {
        response = this;
        const actual = originalWrite.apply(
          this,
          arguments as unknown as Parameters<ServerResponse['write']>,
        );
        return forceBackpressure ? false : actual;
      } as ServerResponse['write'];
      ReadableStream.prototype.getReader = function (this: ReadableStream<Uint8Array>) {
        const reader = originalReader.call(this) as ReadableStreamDefaultReader<Uint8Array>;
        const originalCancel = reader.cancel.bind(reader);
        reader.cancel = (reason) => {
          cancelled++;
          return originalCancel(reason);
        };
        return reader;
      } as typeof originalReader;
      const server = await startLocalRelay();
      const peer = generateKeyPair();
      try {
        await new Promise<void>((resolve, reject) => {
          const request = get(
            server.url + '/stream?recipient=' + encodeURIComponent(peer.did),
            {
              headers: {
                authorization: 'Bearer ' + createRelayAuthToken(peer, { action: 'stream' }),
              },
            },
            (incoming) => {
              incoming.once('data', () => {
                incoming.destroy();
                request.destroy();
                resolve();
              });
              incoming.on('error', () => {});
            },
          );
          request.on('error', reject);
          request.setTimeout(1000, () => {
            request.destroy(new Error('probe timeout'));
          });
        });
        await new Promise((resolve) => setTimeout(resolve, 80));
        results.push({
          forceBackpressure,
          readerCancelCalls: cancelled,
          remainingDrainListeners: response?.listenerCount('drain') ?? -1,
        });
        if (forceBackpressure && response) {
          response.emit('drain');
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      } finally {
        await server.close();
        ServerResponse.prototype.write = originalWrite;
        ReadableStream.prototype.getReader = originalReader;
      }
    }
    expect(results).toEqual([
      { forceBackpressure: false, readerCancelCalls: 1, remainingDrainListeners: 0 },
      { forceBackpressure: true, readerCancelCalls: 1, remainingDrainListeners: 0 },
    ]);
  });
});
