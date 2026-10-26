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
import type { AgentAdapter, ApprovalProvider } from '@acp/runtime';
import {
  CommandAgentAdapter,
  ClaudeCodeAdapter,
  CodexCliAdapter,
  OpenAICompatibleAdapter,
  SandboxAgentAdapter,
} from '@acp/adapters';
function flags(args: string[]): Map<string, string | true> {
  const out = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) throw new Error('Unexpected argument: ' + arg);
    if (out.has(arg)) throw new Error('Duplicate option: ' + arg);
    out.set(arg, args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true);
  }
  return out;
}
function text(f: Map<string, string | true>, name: string, fallback?: string): string {
  const value = f.get('--' + name) ?? fallback;
  if (typeof value !== 'string') throw new Error('Missing --' + name);
  return value;
}
function approval(key: KeyPair, automatic: boolean): ApprovalProvider {
  return automatic ? new PolicyAutoApprovalProvider(key) : new InteractiveCliApprovalProvider(key);
}
export async function networkCommand(command: string, args: string[]): Promise<void> {
  const sub = ['relay', 'worker', 'invite'].includes(command) ? args.shift() : undefined;
  if ((command === 'relay' || command === 'worker') && sub !== 'start')
    throw new Error('Expected ' + command + ' start');
  if (command === 'invite' && sub !== 'create') throw new Error('Expected invite create');
  const f = flags(args);
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
    const client = new HttpRelayClient(text(f, 'relay'));
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
    let adapter: AgentAdapter;
    switch (text(f, 'adapter', 'sandbox')) {
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
      relay: new HttpRelayClient(text(f, 'relay'), key),
      relayUrl: text(f, 'relay'),
      adapter,
      name: text(f, 'name', adapter.name),
      approvalProvider: approval(key, automatic),
      auditPath: f.has('--audit') ? text(f, 'audit') : undefined,
      onEvent: (event, taskId) => console.error(JSON.stringify({ event, taskId })),
    });
    await worker.register();
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
      ...(f.has('--relay') ? { relay: new HttpRelayClient(text(f, 'relay'), key) } : {}),
      approvalProvider: approval(key, automatic),
      auditPath: f.has('--audit') ? text(f, 'audit') : undefined,
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
