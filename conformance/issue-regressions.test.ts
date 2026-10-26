// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, writeFile, rm as rmDir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRelayAuthToken,
  createSignedAgentCard,
  generateKeyPair,
  signEnvelope,
} from '../packages/core/src/index.js';
import { InMemoryRelay, createRelayFetchHandler } from '../packages/relay/src/fetch.js';
import { RelayDurableObject } from '../packages/relay/src/worker.js';
import {
  PolicyAutoApprovalProvider,
  RequesterClient,
  WorkerNode,
  buildTaskManifest,
} from '../packages/runtime/src/index.js';
import { ClaudeCodeAdapter, runCommand } from '../packages/adapters/src/command.js';
import type { AgentTaskContext } from '../packages/adapters/src/command.js';
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
      name: 'Synthetic echo',
      skills: [],
      executeTask: async (context: { input: unknown }) => context.input,
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
          get: async (key: string) => data.get(key),
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
