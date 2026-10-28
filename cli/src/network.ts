// SPDX-License-Identifier: Apache-2.0
import { readFileSync, writeFileSync } from 'node:fs';
import type { KeyPair, Schema } from '@acp/core';
import { createSignedAgentCard, createInviteToken } from '@acp/core';
import { startLocalRelay, HttpRelayClient } from '@acp/relay';
import {
  WorkerNode,
  RequesterClient,
  PolicyAutoApprovalProvider,
  InteractiveCliApprovalProvider,
} from '@acp/runtime';
import type { AgentAdapter, ApprovalProvider, WorkerAcceptancePolicy } from '@acp/runtime';
import {
  CommandAgentAdapter,
  ClaudeCodeAdapter,
  CodexCliAdapter,
  OpenAICompatibleAdapter,
  SandboxAgentAdapter,
} from '@acp/adapters';
const REPEATABLE = new Set(['--allow-requester']);
const LLM_ADAPTERS = new Set(['claude', 'codex', 'openai']);
function flags(args: string[]): Map<string, string | true> {
  const out = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) throw new Error('Unexpected argument: ' + arg);
    const next = args[i + 1];
    const value = next && !next.startsWith('--') ? args[++i] : true;
    if (REPEATABLE.has(arg)) {
      if (typeof value !== 'string' || value.trim() === '')
        throw new Error('Missing --allow-requester');
      const previous = out.get(arg);
      out.set(arg, (typeof previous === 'string' && previous ? previous + ',' : '') + value);
      continue;
    }
    if (out.has(arg)) throw new Error('Duplicate option: ' + arg);
    out.set(arg, value);
  }
  return out;
}
function text(f: Map<string, string | true>, name: string, fallback?: string): string {
  const value = f.get('--' + name) ?? fallback;
  if (typeof value !== 'string') throw new Error('Missing --' + name);
  return value;
}
function approval(
  key: KeyPair,
  automatic: boolean,
  acceptance?: WorkerAcceptancePolicy,
): ApprovalProvider {
  return automatic
    ? new PolicyAutoApprovalProvider(key, undefined, { acceptance })
    : new InteractiveCliApprovalProvider(key);
}
function optionalCount(parsed: Map<string, string | true>, name: string): number | undefined {
  if (!parsed.has('--' + name)) return undefined;
  const raw = text(parsed, name);
  if (!/^[1-9]\d*$/.test(raw))
    throw new Error('INVALID_' + name.toUpperCase().replaceAll('-', '_'));
  const value = Number(raw);
  if (!Number.isSafeInteger(value))
    throw new Error('INVALID_' + name.toUpperCase().replaceAll('-', '_'));
  return value;
}
function allowRequesterDids(parsed: Map<string, string | true>): string[] {
  const raw = parsed.get('--allow-requester');
  if (raw === undefined) return [];
  if (typeof raw !== 'string') throw new Error('Missing --allow-requester');
  const dids = raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (dids.length === 0) throw new Error('Missing --allow-requester');
  return dids;
}
function workerAcceptance(parsed: Map<string, string | true>): WorkerAcceptancePolicy {
  return {
    allowedRequesterDids: allowRequesterDids(parsed),
    allowAnyRequester: parsed.has('--allow-any-requester'),
    maxInputTokens: optionalCount(parsed, 'max-input-tokens'),
    maxOutputTokens: optionalCount(parsed, 'max-output-tokens'),
    maxToolInvocations: optionalCount(parsed, 'max-tool-invocations'),
    maxWallClockSeconds: optionalCount(parsed, 'max-wall-clock-seconds'),
    maxConcurrentTasks: optionalCount(parsed, 'max-concurrent-tasks'),
    maxTasksPerRequesterPerMinute: optionalCount(parsed, 'max-requests-per-minute'),
    publishToRegistry: parsed.has('--publish'),
  };
}
function assertLlmAutoAccept(
  adapter: string,
  automatic: boolean,
  acceptance: WorkerAcceptancePolicy,
): void {
  if (!automatic || !LLM_ADAPTERS.has(adapter)) return;
  if (acceptance.allowAnyRequester || (acceptance.allowedRequesterDids?.length ?? 0) > 0) return;
  throw new Error(
    'LLM_AUTO_ACCEPT_REQUIRES_ALLOWLIST: --auto-accept with the ' +
      adapter +
      ' adapter can spend the worker owner API key. Pass --allow-requester <did> ' +
      '(repeatable or comma-separated) or --allow-any-requester.',
  );
}
export async function networkCommand(command: string, args: string[]): Promise<void> {
  const sub = ['relay', 'worker', 'invite'].includes(command) ? args.shift() : undefined;
  if ((command === 'relay' || command === 'worker') && sub !== 'start')
    throw new Error('Expected ' + command + ' start');
  if (command === 'invite' && sub !== 'create') throw new Error('Expected invite create');
  const f = flags(args);
  const allowPrivateRelay = f.has('--allow-private-relay');
  if (command === 'relay') {
    const port = Number(text(f, 'port', '8787'));
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('INVALID_PORT');
    const relay = await startLocalRelay({ port, host: text(f, 'host', '127.0.0.1') });
    console.log(JSON.stringify({ relay: relay.url }));
    await new Promise<void>((resolve) => {
      const stop = () => resolve();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
    await relay.close();
    return;
  }
  if (command === 'discover') {
    const client = new HttpRelayClient(text(f, 'relay'), { allowPrivateRelay });
    console.log(JSON.stringify(await client.discover(), null, 2));
    return;
  }
  const key = JSON.parse(readFileSync(text(f, 'key'), 'utf8')) as KeyPair;
  if (command === 'invite') {
    const card = createSignedAgentCard(
      {
        name: text(f, 'name', 'ACP Worker'),
        agentDid: key.did,
        relayEndpoint: text(f, 'relay'),
        skills: [{ id: 'json-task', name: 'JSON task' }],
      },
      key,
    );
    console.log(
      createInviteToken(
        { agentCard: card, expiresInSeconds: Number(text(f, 'expires-in', '3600')) },
        key,
      ),
    );
    return;
  }
  const automatic = ['yes', 'auto-accept', 'auto-approve'].some((name) => f.has('--' + name));
  if (command === 'worker') {
    const adapterName = text(f, 'adapter', 'sandbox');
    const acceptance = workerAcceptance(f);
    assertLlmAutoAccept(adapterName, automatic, acceptance);
    let adapter: AgentAdapter;
    switch (adapterName) {
      case 'command':
        adapter = new CommandAgentAdapter({ command: text(f, 'cmd') });
        break;
      case 'claude':
        adapter = new ClaudeCodeAdapter(f.has('--cmd') ? { command: text(f, 'cmd') } : {});
        break;
      case 'codex':
        adapter = new CodexCliAdapter(f.has('--cmd') ? { command: text(f, 'cmd') } : {});
        break;
      case 'openai':
        adapter = new OpenAICompatibleAdapter({
          model: text(f, 'model', 'gpt-4o-mini'),
          ...(f.has('--endpoint') ? { endpoint: text(f, 'endpoint') } : {}),
        });
        break;
      case 'sandbox':
        adapter = new SandboxAgentAdapter(text(f, 'cmd', 'return input;'));
        break;
      default:
        throw new Error('UNKNOWN_ADAPTER');
    }
    const worker = new WorkerNode({
      owner: key,
      relay: new HttpRelayClient(text(f, 'relay'), key, { allowPrivateRelay }),
      relayUrl: text(f, 'relay'),
      adapter,
      name: text(f, 'name', adapter.name),
      approvalProvider: approval(key, automatic, acceptance),
      auditPath: f.has('--audit') ? text(f, 'audit') : undefined,
      inboxPath: f.has('--inbox') ? text(f, 'inbox') : undefined,
      onEvent: (event, taskId) => console.error(JSON.stringify({ event, taskId })),
      ...acceptance,
      allowPrivateRelay,
    });
    if (acceptance.publishToRegistry) await worker.register();
    console.log(worker.invite());
    const stop = () => worker.stop();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      await worker.start({ once: f.has('--once') });
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
    return;
  }
  if (command === 'delegate') {
    let outputSchema: Schema = {};
    if (f.has('--output-schema')) {
      const value = text(f, 'output-schema');
      outputSchema = JSON.parse(
        value.trim().startsWith('{') ? value : readFileSync(value, 'utf8'),
      ) as Schema;
    }
    const client = new RequesterClient({
      owner: key,
      ...(f.has('--relay')
        ? { relay: new HttpRelayClient(text(f, 'relay'), key, { allowPrivateRelay }) }
        : {}),
      approvalProvider: approval(key, automatic),
      auditPath: f.has('--audit') ? text(f, 'audit') : undefined,
      allowPrivateRelay,
    });
    const result = await client.delegate({
      to: text(f, 'to'),
      title: text(f, 'title'),
      description: text(f, 'description'),
      input: JSON.parse(text(f, 'input')),
      outputSchema,
    });
    if (f.has('--out'))
      writeFileSync(text(f, 'out'), JSON.stringify(result.deliverable, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
    console.log(
      JSON.stringify({
        taskId: result.taskId,
        state: result.state,
        deliverable: result.deliverable,
        audit: 'VALID',
      }),
    );
    return;
  }
  throw new Error('UNKNOWN_NETWORK_COMMAND');
}
