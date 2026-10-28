// SPDX-License-Identifier: Apache-2.0
import { ServerResponse } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPair } from '../packages/core/src/index.js';
import type { BudgetSpec, Json, KeyPair, TaskManifest } from '../packages/core/src/index.js';
import { QuotaMeter, buildTaskManifest } from '../packages/runtime/src/index.js';
import {
  ClaudeCodeAdapter,
  CodexCliAdapter,
  startCredentialProxy,
  type AgentTaskContext,
  type CredentialProxyHandle,
  type CredentialProxyOptions,
  type ProxyUsageMetrics,
  type UsageMetrics,
} from '../packages/adapters/src/index.js';
import { startCredentialProxy as startCredentialProxyFromModule } from '../packages/adapters/src/credential-proxy.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function budget(overrides: Partial<BudgetSpec> = {}): BudgetSpec {
  return {
    costBearer: 'worker_byok',
    maxInputTokens: 100,
    maxOutputTokens: 100,
    maxToolInvocations: 8,
    maxWallClockSeconds: 60,
    onOverrun: 'hard_stop',
    ...overrides,
  };
}

function bearer(proxy: CredentialProxyHandle, token = proxy.token): Record<string, string> {
  return { authorization: 'Bearer ' + token };
}

function apiKey(proxy: CredentialProxyHandle, token = proxy.token): Record<string, string> {
  return { 'x-api-key': token };
}

function sameLengthToken(token: string): string {
  const last = token[token.length - 1] ?? 'a';
  return token.slice(0, -1) + (last === 'a' ? 'b' : 'a');
}

async function withProxy(
  options: Partial<Omit<CredentialProxyOptions, 'fetch'>> & Pick<CredentialProxyOptions, 'fetch'>,
  run: (proxy: CredentialProxyHandle) => Promise<void>,
): Promise<void> {
  const { signal, ...rest } = options;
  const proxy = await startCredentialProxy({
    apiKey: 'synthetic-provider-key',
    baseUrl: 'https://api.openai.com/v1',
    style: 'openai',
    signal: signal ?? AbortSignal.timeout(8000),
    ...rest,
  });
  try {
    await run(proxy);
  } finally {
    await proxy.close();
  }
}

async function post(
  proxy: CredentialProxyHandle,
  headers: Record<string, string>,
  path = '/v1/chat/completions',
): Promise<{ status: number; text: string; json: unknown }> {
  const response = await fetch(proxy.url + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ prompt: 'task' }),
  });
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    json = undefined;
  }
  return { status: response.status, text, json };
}

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

function splitText(text: string, size: number): string[] {
  const parts: string[] = [];
  for (let index = 0; index < text.length; index += size)
    parts.push(text.slice(index, index + size));
  return parts;
}

function dataEvent(payload: unknown): string {
  return 'data: ' + JSON.stringify(payload) + '\n\n';
}

function namedEvent(name: string, payload: unknown): string {
  return 'event: ' + name + '\r\ndata: ' + JSON.stringify(payload) + '\r\n\r\n';
}

function tokenReports(deltas: Array<Partial<UsageMetrics>>): Array<Partial<UsageMetrics>> {
  return deltas.filter(
    (delta) => delta.inputTokens !== undefined || delta.outputTokens !== undefined,
  );
}

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'acp-p14-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function taskContext(
  manifest: TaskManifest,
  reportUsage: AgentTaskContext['reportUsage'],
  signal: AbortSignal = AbortSignal.timeout(15000),
): Promise<AgentTaskContext> {
  return {
    taskId: manifest.taskId,
    manifest,
    input: { value: 1 },
    workspaceDir: await workspace(),
    signal,
    callTool: async () => {
      throw new Error('TOOL_DENIED');
    },
    reportUsage,
    reportIsolation: () => {},
  };
}

describe('P1-4 credential proxy metering', () => {
  it('exports startCredentialProxy from the adapters barrel and the module', () => {
    expect(startCredentialProxy).toBe(startCredentialProxyFromModule);
  });

  it('accepts bearer and x-api-key tokens and rejects other lengths with 401', async () => {
    let calls = 0;
    await withProxy(
      {
        fetch: async () => {
          calls += 1;
          return Response.json({ usage: { prompt_tokens: 1, completion_tokens: 1 } });
        },
      },
      async (proxy) => {
        const forged = sameLengthToken(proxy.token);
        expect(forged).toHaveLength(proxy.token.length);
        expect(forged).not.toBe(proxy.token);
        const rejected: Array<Record<string, string>> = [
          { authorization: 'Bearer ' + forged },
          { authorization: 'Bearer nope' },
          { authorization: 'Bearer ' + proxy.token + 'x' },
          { 'x-api-key': forged },
          { 'x-api-key': 'short' },
          { 'x-api-key': proxy.token + 'extra' },
          {},
        ];
        for (const headers of rejected) {
          const denied = await post(proxy, headers);
          expect(denied.status).toBe(401);
          expect(denied.text).toBe('');
        }
        const apiKeyWins = await post(proxy, {
          authorization: 'Bearer nope',
          'x-api-key': proxy.token,
        });
        expect(apiKeyWins.status).toBe(200);
        const bearerWins = await post(proxy, {
          authorization: 'Bearer ' + proxy.token,
          'x-api-key': 'x',
        });
        expect(bearerWins.status).toBe(200);
        expect(bearerWins.json).toEqual({ usage: { prompt_tokens: 1, completion_tokens: 1 } });
        expect((await post(proxy, bearer(proxy), '/v1/models')).status).toBe(403);
        expect(calls).toBe(2);
      },
    );
  });

  it('meters OpenAI and Anthropic JSON usage and then rejects with 429', async () => {
    const seen: ProxyUsageMetrics[] = [];
    let calls = 0;
    const bodies = [
      { id: 'chat', usage: { prompt_tokens: 6, completion_tokens: 2, total_tokens: 8 } },
      { id: 'msg', usage: { input_tokens: 5, output_tokens: 4, total_tokens: 9 } },
    ];
    await withProxy(
      {
        budget: budget({ maxInputTokens: 10, maxOutputTokens: 10, maxToolInvocations: 10 }),
        maxRequests: 10,
        reportUsage: (metrics) => seen.push(metrics),
        fetch: async () => {
          calls += 1;
          if (calls > bodies.length) throw new Error('UPSTREAM_FETCH');
          return Response.json(bodies[calls - 1]);
        },
      },
      async (proxy) => {
        const first = await post(proxy, bearer(proxy));
        const second = await post(proxy, apiKey(proxy));
        const blocked = await post(proxy, bearer(proxy));
        expect(first.status).toBe(200);
        expect(first.json).toEqual(bodies[0]);
        expect(second.status).toBe(200);
        expect(second.json).toEqual(bodies[1]);
        expect(blocked.status).toBe(429);
        expect(blocked.json).toEqual({ error: 'BUDGET_EXCEEDED' });
        expect(calls).toBe(2);
        expect(seen).toEqual([
          { inputTokens: 6, outputTokens: 2, totalTokens: 8 },
          { inputTokens: 5, outputTokens: 4, totalTokens: 9 },
        ]);
        expect(proxy.responsesMetered).toBe(2);
      },
    );
  });

  it('rejects the next request when JSON output tokens exceed the budget', async () => {
    let calls = 0;
    const seen: ProxyUsageMetrics[] = [];
    await withProxy(
      {
        budget: budget({ maxInputTokens: 50, maxOutputTokens: 5 }),
        reportUsage: (metrics) => seen.push(metrics),
        fetch: async () => {
          calls += 1;
          if (calls > 1) throw new Error('UPSTREAM_FETCH');
          return Response.json({ usage: { input_tokens: 2, output_tokens: 6 } });
        },
      },
      async (proxy) => {
        expect((await post(proxy, bearer(proxy), '/v1/messages')).status).toBe(200);
        const blocked = await post(proxy, bearer(proxy), '/v1/messages');
        expect(blocked.status).toBe(429);
        expect(blocked.json).toEqual({ error: 'BUDGET_EXCEEDED' });
        expect(calls).toBe(1);
        expect(seen).toEqual([{ inputTokens: 2, outputTokens: 6, totalTokens: 8 }]);
      },
    );
  });

  it('meters cumulative SSE usage across chunk boundaries and stops after overrun', async () => {
    const anthropicSse = [
      namedEvent('message_start', {
        type: 'message_start',
        message: { usage: { input_tokens: 25, output_tokens: 1 } },
      }),
      namedEvent('content_block_delta', {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Hi' },
      }),
      namedEvent('message_delta', {
        type: 'message_delta',
        usage: { output_tokens: 15 },
      }),
      namedEvent('message_stop', { type: 'message_stop' }),
    ].join('');
    const openaiChatSse = [
      dataEvent({
        choices: [{ delta: { content: 'Hi' } }],
        usage: { prompt_tokens: 9, completion_tokens: 1 },
      }),
      dataEvent({
        choices: [],
        usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
      }),
      'data: [DONE]\n\n',
    ].join('');
    const openaiResponsesSse = [
      dataEvent({ type: 'response.output_text.delta', delta: 'Hi' }),
      dataEvent({
        type: 'response.completed',
        response: { usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 } },
      }),
      dataEvent({
        type: 'response.done',
        usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
      }),
    ].join('');
    const streams = [anthropicSse, openaiChatSse, openaiResponsesSse];
    const seen: ProxyUsageMetrics[] = [];
    let calls = 0;
    await withProxy(
      {
        budget: budget({ maxInputTokens: 40, maxOutputTokens: 30, maxToolInvocations: 10 }),
        maxRequests: 10,
        reportUsage: (metrics) => seen.push(metrics),
        fetch: async () => {
          calls += 1;
          if (calls > streams.length) throw new Error('UPSTREAM_FETCH');
          return sseResponse(splitText(streams[calls - 1] ?? '', 5));
        },
      },
      async (proxy) => {
        const anthropic = await post(proxy, apiKey(proxy), '/v1/messages');
        const chat = await post(proxy, bearer(proxy), '/v1/chat/completions');
        const responses = await post(proxy, bearer(proxy), '/v1/responses');
        const blocked = await post(proxy, bearer(proxy), '/v1/responses');
        expect(anthropic.status).toBe(200);
        expect(anthropic.text).toBe(anthropicSse);
        expect(chat.status).toBe(200);
        expect(chat.text).toBe(openaiChatSse);
        expect(responses.status).toBe(200);
        expect(responses.text).toBe(openaiResponsesSse);
        expect(blocked.status).toBe(429);
        expect(blocked.json).toEqual({ error: 'BUDGET_EXCEEDED' });
        expect(calls).toBe(3);
        expect(seen).toEqual([
          { inputTokens: 25, outputTokens: 15, totalTokens: 40 },
          { inputTokens: 9, outputTokens: 4, totalTokens: 13 },
          { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
        ]);
      },
    );
  });

  it('meters a top-level response.done usage event once', async () => {
    const seen: ProxyUsageMetrics[] = [];
    const stream = dataEvent({
      type: 'response.done',
      usage: { input_tokens: 2, output_tokens: 2 },
    });
    await withProxy(
      {
        reportUsage: (metrics) => seen.push(metrics),
        fetch: async () => sseResponse(splitText(stream, 3)),
      },
      async (proxy) => {
        const response = await post(proxy, bearer(proxy), '/v1/responses');
        expect(response.status).toBe(200);
        expect(response.text).toBe(stream);
        expect(seen).toEqual([{ inputTokens: 2, outputTokens: 2, totalTokens: 4 }]);
      },
    );
  });

  it('rejects with 429 when the request cap is reached', async () => {
    let calls = 0;
    await withProxy(
      {
        maxRequests: 2,
        budget: budget({ maxInputTokens: 1000, maxOutputTokens: 1000, maxToolInvocations: 100 }),
        fetch: async () => {
          calls += 1;
          if (calls > 2) throw new Error('UPSTREAM_FETCH');
          return Response.json({ ok: true });
        },
      },
      async (proxy) => {
        expect((await post(proxy, bearer(proxy))).status).toBe(200);
        expect((await post(proxy, apiKey(proxy))).status).toBe(200);
        const blocked = await post(proxy, bearer(proxy));
        expect(blocked.status).toBe(429);
        expect(blocked.json).toEqual({ error: 'RATE_LIMITED' });
        expect(calls).toBe(2);
        expect(proxy.responsesMetered).toBe(0);
      },
    );
  });

  it('defaults the request cap from the budget tool limit, otherwise 16', async () => {
    async function statuses(options: Partial<CredentialProxyOptions>, count: number) {
      const results: number[] = [];
      let calls = 0;
      await withProxy(
        {
          ...options,
          fetch: async () => {
            calls += 1;
            return Response.json({ ok: true });
          },
        },
        async (proxy) => {
          for (let index = 0; index < count; index++)
            results.push((await post(proxy, bearer(proxy))).status);
        },
      );
      return { results, calls };
    }
    const fromBudget = await statuses(
      { budget: budget({ maxToolInvocations: 3, maxInputTokens: 1000, maxOutputTokens: 1000 }) },
      4,
    );
    expect(fromBudget.results).toEqual([200, 200, 200, 429]);
    expect(fromBudget.calls).toBe(3);
    const fallback = await statuses({}, 17);
    expect(fallback.results.slice(0, 16).every((status) => status === 200)).toBe(true);
    expect(fallback.results[16]).toBe(429);
    expect(fallback.calls).toBe(16);
  });

  it('rejects an explicit request cap below 1', async () => {
    await expect(
      startCredentialProxy({
        apiKey: 'synthetic-provider-key',
        baseUrl: 'https://api.openai.com/v1',
        style: 'openai',
        signal: AbortSignal.timeout(1000),
        maxRequests: 0,
        fetch: async () => Response.json({ ok: true }),
      }),
    ).rejects.toThrow('INVALID_MAX_REQUESTS');
  });

  it('rejects before fetch when the meter or task signal is already halted', async () => {
    const owner = generateKeyPair();
    const limits = budget({ maxInputTokens: 1, maxOutputTokens: 1 });
    const meter = new QuotaMeter('task_proxy_halt', limits, owner.did);
    try {
      expect(() => meter.record(2, 0)).toThrow(/BUDGET_EXCEEDED/);
      let calls = 0;
      await withProxy(
        {
          meter,
          budget: limits,
          fetch: async () => {
            calls += 1;
            return Response.json({ usage: { prompt_tokens: 1, completion_tokens: 1 } });
          },
        },
        async (proxy) => {
          const denied = await post(proxy, apiKey(proxy));
          expect(denied.status).toBe(429);
          expect(denied.json).toEqual({ error: 'BUDGET_EXCEEDED' });
          expect(calls).toBe(0);
        },
      );
    } finally {
      meter.close();
    }
    const controller = new AbortController();
    controller.abort('BUDGET_EXCEEDED: quota');
    let calls = 0;
    await withProxy(
      {
        signal: controller.signal,
        fetch: async () => {
          calls += 1;
          return Response.json({ usage: { prompt_tokens: 1, completion_tokens: 1 } });
        },
      },
      async (proxy) => {
        const denied = await post(proxy, bearer(proxy));
        expect(denied.status).toBe(429);
        expect(denied.json).toEqual({ error: 'BUDGET_EXCEEDED' });
        expect(calls).toBe(0);
      },
    );
  });

  it('halts the proxy when reportUsage throws BUDGET_EXCEEDED', async () => {
    let calls = 0;
    const seen: ProxyUsageMetrics[] = [];
    await withProxy(
      {
        maxRequests: 5,
        reportUsage: (metrics) => {
          seen.push(metrics);
          throw new Error('BUDGET_EXCEEDED');
        },
        fetch: async () => {
          calls += 1;
          if (calls > 1) throw new Error('UPSTREAM_FETCH');
          return Response.json({ usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } });
        },
      },
      async (proxy) => {
        expect((await post(proxy, bearer(proxy))).status).toBe(200);
        const blocked = await post(proxy, bearer(proxy));
        expect(blocked.status).toBe(429);
        expect(blocked.json).toEqual({ error: 'BUDGET_EXCEEDED' });
        expect(calls).toBe(1);
        expect(seen).toEqual([{ inputTokens: 3, outputTokens: 1, totalTokens: 4 }]);
      },
    );
  });

  it('keeps stdout usage when the credential proxy is not on the path', async () => {
    const owner = generateKeyPair();
    const worker = generateKeyPair();
    const manifest = buildTaskManifest({
      ownerDid: owner.did,
      workerDid: worker.did,
      title: 'stdout usage',
      description: 'runner path',
    });
    const deltas: Array<Partial<UsageMetrics>> = [];
    const context = await taskContext(manifest, (delta) => deltas.push(delta));
    const claude = new ClaudeCodeAdapter({
      runner: async () => ({
        stdout: JSON.stringify({
          result: '{"ok":true}',
          usage: { input_tokens: 13, output_tokens: 5 },
        }),
      }),
    });
    expect(await claude.executeTask(context)).toEqual({ ok: true });
    const codex = new CodexCliAdapter({
      runner: async () => ({
        stdout: [
          JSON.stringify({
            type: 'item.completed',
            item: { type: 'agent_message', text: '{"ok":true}' },
          }),
          JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 11, output_tokens: 4 } }),
        ].join('\n'),
      }),
    });
    expect(await codex.executeTask(context)).toEqual({ ok: true });
    expect(tokenReports(deltas)).toEqual([
      { inputTokens: 13, outputTokens: 5, totalTokens: 18 },
      { inputTokens: 11, outputTokens: 4, totalTokens: 15 },
    ]);
  });

  it('charges Claude and Codex proxy usage once on the task QuotaMeter', async () => {
    const realKey = 'synthetic-p14-provider-key';
    const cases = [
      {
        kind: 'claude' as const,
        paths: ['/v1/messages', '/v1/messages'],
        responses: [
          { usage: { input_tokens: 4, output_tokens: 1 } },
          { usage: { input_tokens: 6, output_tokens: 3 } },
        ],
        expected: [
          { inputTokens: 4, outputTokens: 1, totalTokens: 5 },
          { inputTokens: 6, outputTokens: 3, totalTokens: 9 },
        ],
        totals: { inputTokens: 10, outputTokens: 4 },
      },
      {
        kind: 'codex' as const,
        paths: ['/v1/chat/completions', '/v1/responses'],
        responses: [
          { usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
          { usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } },
        ],
        expected: [
          { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
          { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
        ],
        totals: { inputTokens: 8, outputTokens: 6 },
      },
    ];
    for (const item of cases) {
      const owner = generateKeyPair();
      const worker = generateKeyPair();
      const manifest = buildTaskManifest({
        ownerDid: owner.did,
        workerDid: worker.did,
        title: item.kind,
        description: 'proxy metering',
      });
      const meter = new QuotaMeter(manifest.taskId, manifest.budget, worker.did);
      const deltas: Array<Partial<UsageMetrics>> = [];
      const urls: string[] = [];
      const keys: string[] = [];
      let calls = 0;
      try {
        const dir = await workspace();
        const script = join(dir, item.kind + '.cjs');
        await writeFile(script, providerScript(item.kind, item.paths.length), { mode: 0o700 });
        const context = await taskContext(
          manifest,
          (delta) => {
            deltas.push(delta);
            meter.recordMetrics(delta);
          },
          AbortSignal.any([AbortSignal.timeout(15000), meter.controller.signal]),
        );
        context.workspaceDir = dir;
        const fetchImpl: typeof fetch = async (url, init) => {
          calls += 1;
          const headers = new Headers(init?.headers);
          urls.push(String(url));
          keys.push(headers.get('x-api-key') ?? headers.get('authorization') ?? '');
          return Response.json(item.responses[calls - 1] ?? { usage: { input_tokens: 100 } });
        };
        const adapter =
          item.kind === 'claude'
            ? new ClaudeCodeAdapter({ binaryPath: script, apiKey: realKey, fetch: fetchImpl })
            : new CodexCliAdapter({ binaryPath: script, apiKey: realKey, fetch: fetchImpl });
        const deliverable = (await adapter.executeTask(context)) as {
          ok: boolean;
          statuses: number[];
          error?: string;
        };
        expect(deliverable.ok, deliverable.error).toBe(true);
        expect(deliverable.statuses).toEqual([200, 200]);
        expect(calls).toBe(2);
        expect(urls.map((url) => new URL(url).pathname)).toEqual(item.paths);
        expect(keys).toEqual(
          item.kind === 'claude' ? [realKey, realKey] : ['Bearer ' + realKey, 'Bearer ' + realKey],
        );
        expect(JSON.stringify(deliverable)).not.toContain(realKey);
        expect(tokenReports(deltas)).toEqual(item.expected);
        const usage = meter.receipt(worker).payload;
        expect(usage.inputTokens).toBe(item.totals.inputTokens);
        expect(usage.outputTokens).toBe(item.totals.outputTokens);
        expect(usage.halted).toBe(false);
      } finally {
        meter.close();
      }
    }
  });

  it('enforces CliOptions.maxRequests inside ClaudeCodeAdapter', async () => {
    const owner = generateKeyPair();
    const worker = generateKeyPair();
    const manifest = buildTaskManifest({
      ownerDid: owner.did,
      workerDid: worker.did,
      title: 'request cap',
      description: 'one upstream call',
    });
    const meter = new QuotaMeter(manifest.taskId, manifest.budget, worker.did);
    const deltas: Array<Partial<UsageMetrics>> = [];
    let calls = 0;
    try {
      const dir = await workspace();
      const script = join(dir, 'claude-cap.cjs');
      await writeFile(script, providerScript('claude', 2), { mode: 0o700 });
      const context = await taskContext(manifest, (delta) => {
        deltas.push(delta);
        meter.recordMetrics(delta);
      });
      context.workspaceDir = dir;
      const adapter = new ClaudeCodeAdapter({
        binaryPath: script,
        apiKey: 'synthetic-p14-provider-key',
        maxRequests: 1,
        fetch: async () => {
          calls += 1;
          if (calls > 1) throw new Error('UPSTREAM_FETCH');
          return Response.json({ usage: { input_tokens: 3, output_tokens: 1 } });
        },
      });
      const deliverable = (await adapter.executeTask(context)) as {
        ok: boolean;
        statuses: number[];
      };
      expect(deliverable).toEqual({ ok: true, statuses: [200, 429] });
      expect(calls).toBe(1);
      expect(tokenReports(deltas)).toEqual([{ inputTokens: 3, outputTokens: 1, totalTokens: 4 }]);
      expect(meter.receipt(worker).payload).toMatchObject({ inputTokens: 3, outputTokens: 1 });
    } finally {
      meter.close();
    }
  });
});

const meteredUsage: ProxyUsageMetrics = { inputTokens: 11, outputTokens: 1, totalTokens: 12 };

function openAiUsageEvent(): string {
  return dataEvent({ usage: { prompt_tokens: 11, completion_tokens: 1 } });
}

function anthropicUsageEvent(): string {
  return namedEvent('message_start', {
    type: 'message_start',
    message: { usage: { input_tokens: 11, output_tokens: 1 } },
  });
}

function streamFrom(parts: readonly string[], fail: boolean, contentType: string): Response {
  const encoder = new TextEncoder();
  let index = 0;
  return new Response(
    new ReadableStream({
      async pull(controller) {
        if (index < parts.length) {
          controller.enqueue(encoder.encode(parts[index] ?? ''));
          index += 1;
          return;
        }
        if (!fail) {
          controller.close();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
        controller.error(new Error('SYNTHETIC_STREAM_FAILURE'));
      },
    }),
    { headers: { 'content-type': contentType } },
  );
}

describe('issue 59: SSE mid-stream errors still count received usage', () => {
  const cases: Array<{
    label: string;
    style: 'openai' | 'anthropic';
    path: string;
    contentType: string;
    parts: string[];
    fail: boolean;
    needle: string;
  }> = [
    {
      label: 'openai event then error',
      style: 'openai',
      path: '/v1/chat/completions',
      contentType: 'text/event-stream',
      parts: [openAiUsageEvent()],
      fail: true,
      needle: '"prompt_tokens":11',
    },
    {
      label: 'openai event split across chunks then error',
      style: 'openai',
      path: '/v1/chat/completions',
      contentType: 'text/event-stream',
      parts: splitText(openAiUsageEvent(), 5),
      fail: true,
      needle: '"prompt_tokens":11',
    },
    {
      label: 'openai usage line still buffered when the stream errors before newline',
      style: 'openai',
      path: '/v1/responses',
      contentType: 'text/event-stream',
      parts: ['data: {"usage":{"prompt_tokens":11,"completion_tokens":1}}'],
      fail: true,
      needle: '"prompt_tokens":11',
    },
    {
      label: 'openai cumulative events then error are charged once',
      style: 'openai',
      path: '/v1/chat/completions',
      contentType: 'text/event-stream',
      parts: [openAiUsageEvent(), openAiUsageEvent()],
      fail: true,
      needle: '"prompt_tokens":11',
    },
    {
      label: 'anthropic message_start then error',
      style: 'anthropic',
      path: '/v1/messages',
      contentType: 'text/event-stream',
      parts: [anthropicUsageEvent()],
      fail: true,
      needle: '"input_tokens":11',
    },
    {
      label: 'anthropic message_start split across chunks then error',
      style: 'anthropic',
      path: '/v1/messages',
      contentType: 'text/event-stream',
      parts: splitText(anthropicUsageEvent(), 7),
      fail: true,
      needle: '"input_tokens":11',
    },
    {
      label: 'buffered json split across chunks then error',
      style: 'openai',
      path: '/v1/chat/completions',
      contentType: 'application/json',
      parts: splitText(JSON.stringify({ usage: { prompt_tokens: 11, completion_tokens: 1 } }), 6),
      fail: true,
      needle: '"prompt_tokens":11',
    },
    {
      label: 'openai event then clean eof',
      style: 'openai',
      path: '/v1/chat/completions',
      contentType: 'text/event-stream',
      parts: [openAiUsageEvent()],
      fail: false,
      needle: '"prompt_tokens":11',
    },
  ];

  it.each(cases)('meters $label and rejects the next request', async (item) => {
    const reports: ProxyUsageMetrics[] = [];
    const recorded: ProxyUsageMetrics[] = [];
    let upstreamCalls = 0;
    await withProxy(
      {
        apiKey: 'synthetic-only-key',
        baseUrl: 'https://synthetic.invalid/v1',
        style: item.style,
        budget: budget({
          maxInputTokens: 10,
          maxOutputTokens: 100,
          maxToolInvocations: 8,
          maxWallClockSeconds: 10,
        }),
        reportUsage: (metrics) => reports.push(metrics),
        meter: {
          controller: new AbortController(),
          record(inputTokens: number, outputTokens: number) {
            recorded.push({
              inputTokens,
              outputTokens,
              totalTokens: inputTokens + outputTokens,
            });
          },
        },
        fetch: async () => {
          upstreamCalls += 1;
          if (upstreamCalls > 1) throw new Error('UPSTREAM_FETCH');
          return streamFrom(item.parts, item.fail, item.contentType);
        },
      },
      async (proxy) => {
        const first = await post(proxy, bearer(proxy), item.path);
        expect(first.status, item.label).toBe(200);
        expect(first.text.startsWith(item.parts.join('')), item.label).toBe(true);
        expect(first.text, item.label).toContain(item.needle);
        if (item.fail) expect(first.text, item.label).toContain('PROVIDER_REQUEST_FAILED');
        else expect(first.text, item.label).not.toContain('PROVIDER_REQUEST_FAILED');
        expect(proxy.responsesMetered, item.label).toBe(1);
        expect(reports, item.label).toEqual([meteredUsage]);
        expect(recorded, item.label).toEqual([meteredUsage]);
        const second = await post(proxy, bearer(proxy), item.path);
        expect(second.status, item.label).toBe(429);
        expect(second.json, item.label).toEqual({ error: 'BUDGET_EXCEEDED' });
        expect(upstreamCalls, item.label).toBe(1);
      },
    );
  });

  it('accounts usage already written when the downstream write throws', async () => {
    const reports: ProxyUsageMetrics[] = [];
    const recorded: ProxyUsageMetrics[] = [];
    let upstreamCalls = 0;
    const originalWrite = ServerResponse.prototype.write;
    ServerResponse.prototype.write = function (
      this: ServerResponse,
      chunk: string | Uint8Array,
      encoding?: BufferEncoding | ((error: Error | null | undefined) => void),
      callback?: (error: Error | null | undefined) => void,
    ): boolean {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      if (text.includes('DOWNSTREAM_WRITE')) throw new Error('DOWNSTREAM_WRITE_FAILED');
      return originalWrite.call(this, chunk, encoding as never, callback as never);
    } as typeof ServerResponse.prototype.write;
    try {
      await withProxy(
        {
          apiKey: 'synthetic-only-key',
          baseUrl: 'https://synthetic.invalid/v1',
          budget: budget({ maxInputTokens: 10, maxOutputTokens: 100 }),
          reportUsage: (metrics) => reports.push(metrics),
          meter: {
            controller: new AbortController(),
            record(inputTokens: number, outputTokens: number) {
              recorded.push({
                inputTokens,
                outputTokens,
                totalTokens: inputTokens + outputTokens,
              });
            },
          },
          fetch: async () => {
            upstreamCalls += 1;
            if (upstreamCalls > 1) throw new Error('UPSTREAM_FETCH');
            return streamFrom(
              [openAiUsageEvent(), 'data: {"marker":"DOWNSTREAM_WRITE"}\n\n'],
              false,
              'text/event-stream',
            );
          },
        },
        async (proxy) => {
          const first = await post(proxy, bearer(proxy));
          expect(first.status).toBe(200);
          expect(first.text).toContain('"prompt_tokens":11');
          expect(first.text).toContain('PROVIDER_REQUEST_FAILED');
          expect(first.text).not.toContain('DOWNSTREAM_WRITE');
          expect(proxy.responsesMetered).toBe(1);
          expect(reports).toEqual([meteredUsage]);
          expect(recorded).toEqual([meteredUsage]);
          const second = await post(proxy, bearer(proxy));
          expect(second.status).toBe(429);
          expect(second.json).toEqual({ error: 'BUDGET_EXCEEDED' });
          expect(upstreamCalls).toBe(1);
        },
      );
    } finally {
      ServerResponse.prototype.write = originalWrite;
    }
  });
});

function providerScript(kind: 'claude' | 'codex', requests: number): string {
  const claude = kind === 'claude';
  return (
    'let input="";process.stdin.on("data",b=>input+=b);process.stdin.on("end",async()=>{' +
    'const statuses=[];try{' +
    `for(let i=0;i<${requests};i++){` +
    'const response=await fetch(' +
    (claude
      ? 'process.env.ANTHROPIC_BASE_URL+"/v1/messages"'
      : 'process.env.OPENAI_BASE_URL+(i===0?"/chat/completions":"/responses")') +
    ',{method:"POST",headers:{' +
    (claude
      ? '"x-api-key":process.env.ANTHROPIC_API_KEY'
      : 'authorization:"Bearer "+process.env.OPENAI_API_KEY') +
    ',"content-type":"application/json"},body:JSON.stringify({n:i})});' +
    'statuses.push(response.status);await response.text();}' +
    (claude
      ? 'process.stdout.write(JSON.stringify({result:JSON.stringify({ok:true,statuses}),usage:{input_tokens:90,output_tokens:80}}));'
      : 'process.stdout.write([JSON.stringify({type:"item.completed",item:{type:"agent_message",text:JSON.stringify({ok:true,statuses})}}),JSON.stringify({type:"turn.completed",usage:{input_tokens:70,output_tokens:60}})].join("\\n"));') +
    '}catch(error){' +
    (claude
      ? 'process.stdout.write(JSON.stringify({result:JSON.stringify({ok:false,error:String(error),statuses}),usage:{input_tokens:90,output_tokens:80}}));'
      : 'process.stdout.write(JSON.stringify({type:"turn.failed",error:String(error)}));') +
    '}});'
  );
}
