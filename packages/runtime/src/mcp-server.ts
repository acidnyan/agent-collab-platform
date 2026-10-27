// SPDX-License-Identifier: Apache-2.0
import { createSignedAgentCard, createInviteToken, createRevocationNotice } from '@acp/core';
import type { BudgetSpec, Json, KeyPair, Schema } from '@acp/core';
import { RevocationRegistry } from '@acp/core';
import type { AuditBundle } from '@acp/ledger';
import { verifyAudit } from '@acp/ledger';
import type { RelayTransport } from '@acp/relay';
import type { Readable, Writable } from 'node:stream';
import { PolicyAutoApprovalProvider } from './approval-providers.js';
import type { DelegateMultiOptions, DelegateOptions } from './session.js';
import { RequesterClient } from './session.js';

export interface AcpMcpServerOptions {
  owner: KeyPair;
  relay?: RelayTransport | string;
  revocation?: RevocationRegistry;
  name?: string;
  /** Signs agentDid on acp_create_invite when that DID is not the server owner. */
  agentKey?: KeyPair;
}

interface RpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: unknown;
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const PROTOCOL_VERSION = '2024-11-05';

function rpcError(id: unknown, code: number, message: string): Json {
  return { jsonrpc: '2.0', id: (id ?? null) as Json, error: { code, message } };
}

function toolResult(value: unknown, isError = false): Json {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    isError,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RpcError(-32602, 'Invalid params');
  return value as Record<string, unknown>;
}

const tools: Array<{ name: string; description: string; inputSchema: Json }> = [
  {
    name: 'acp_delegate_task',
    description:
      'Delegate one task to an ACP worker and return the verified deliverable plus an audit summary.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        relayUrl: { type: 'string' },
        inviteToken: { type: 'string' },
        workerDid: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        input: {},
        outputSchema: { type: 'object' },
        budget: { type: 'object' },
        minimumIsolationLevel: { type: 'string' },
      },
      required: ['title'],
    },
  },
  {
    name: 'acp_delegate_multi',
    description:
      'Delegate one task to several workers. race returns the first verified deliverable. quorum returns the matching verified digest.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        workers: { type: 'array' },
        mode: { type: 'string', enum: ['race', 'quorum'] },
        quorumSize: { type: 'integer' },
        relayUrl: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        input: {},
        outputSchema: { type: 'object' },
        budget: { type: 'object' },
        minimumIsolationLevel: { type: 'string' },
      },
      required: ['workers', 'mode', 'title'],
    },
  },
  {
    name: 'acp_verify_audit_bundle',
    description: 'Verify a bilateral AuditBundle and return the verification report.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { bundle: { type: 'object' }, anchor: { type: 'object' } },
      required: ['bundle'],
    },
  },
  {
    name: 'acp_create_invite',
    description: 'Sign an acp-invite token for this server owner.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        relayUrl: { type: 'string' },
        name: { type: 'string' },
        expiresInSeconds: { type: 'integer' },
        agentDid: { type: 'string' },
      },
      required: ['relayUrl'],
    },
  },
  {
    name: 'acp_revoke_token',
    description: 'Sign a RevocationNotice and record it in this server registry.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        targetType: { type: 'string', enum: ['invite', 'capability'] },
        targetId: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['targetType', 'targetId', 'reason'],
    },
  },
];

/** Dependency-free MCP server for ACP delegation, audit verification, and revocation. */
export class AcpMcpServer {
  readonly revocation: RevocationRegistry;
  private framed: boolean | undefined;
  constructor(readonly options: AcpMcpServerOptions) {
    this.revocation = options.revocation ?? new RevocationRegistry();
  }
  async handle(message: unknown): Promise<Json | undefined> {
    if (!message || typeof message !== 'object' || Array.isArray(message))
      return rpcError(null, -32600, 'Invalid Request');
    const request = message as RpcRequest;
    const hasId = Object.hasOwn(message, 'id');
    const id = hasId ? request.id : null;
    if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      if (!hasId) return undefined;
      return rpcError(id, -32600, 'Invalid Request');
    }
    try {
      const result = await this.dispatch(request.method, request.params);
      if (!hasId) return undefined;
      return { jsonrpc: '2.0', id: id as Json, result };
    } catch (error) {
      if (!hasId) return undefined;
      const code = error instanceof RpcError ? error.code : -32603;
      const messageText = error instanceof Error ? error.message : String(error);
      return rpcError(id, code, messageText);
    }
  }
  /** Read newline-delimited JSON or Content-Length frames and answer in the same framing. */
  async serve(input: Readable, output: Writable): Promise<void> {
    let buffer: Buffer = Buffer.alloc(0);
    for await (const chunk of input) {
      const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      buffer = Buffer.concat([buffer, next]);
      buffer = await this.drain(buffer, output);
    }
  }
  private async drain(buffer: Buffer, output: Writable): Promise<Buffer> {
    let rest = buffer;
    while (rest.length > 0) {
      if (this.framed === undefined) {
        const preview = rest.toString('utf8');
        if (preview.startsWith('Content-Length')) this.framed = true;
        else if (preview.trimStart().startsWith('{') || preview.includes('\n')) this.framed = false;
        else break;
      }
      if (this.framed) {
        const headerEnd = rest.indexOf('\r\n\r\n');
        if (headerEnd < 0) break;
        const header = rest.subarray(0, headerEnd).toString('utf8');
        const match = /Content-Length:\s*(\d+)/i.exec(header);
        if (!match) throw new Error('INVALID_FRAMING');
        const length = Number(match[1]);
        const start = headerEnd + 4;
        if (rest.length < start + length) break;
        const body = rest.subarray(start, start + length).toString('utf8');
        rest = rest.subarray(start + length);
        await this.reply(output, body);
      } else {
        const newline = rest.indexOf(0x0a);
        if (newline < 0) break;
        const line = rest.subarray(0, newline).toString('utf8').replace(/\r$/, '');
        rest = rest.subarray(newline + 1);
        if (line.trim()) await this.reply(output, line);
      }
    }
    return rest;
  }
  private async reply(output: Writable, body: string): Promise<void> {
    let message: unknown;
    try {
      message = JSON.parse(body);
    } catch {
      this.write(output, rpcError(null, -32700, 'Parse error'));
      return;
    }
    const response = await this.handle(message);
    if (response !== undefined) this.write(output, response);
  }
  private write(output: Writable, value: Json): void {
    const json = JSON.stringify(value);
    if (this.framed) output.write('Content-Length: ' + Buffer.byteLength(json) + '\r\n\r\n' + json);
    else output.write(json + '\n');
  }
  private async dispatch(method: string, params: unknown): Promise<Json> {
    if (method === 'initialize') {
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'acp-mcp-server', version: '0.1.0' },
      };
    }
    if (method === 'notifications/initialized') return {};
    if (method === 'ping') return {};
    if (method === 'tools/list') return { tools: tools as unknown as Json };
    if (method === 'tools/call') return this.toolsCall(params);
    throw new RpcError(-32601, 'Method not found');
  }
  private async toolsCall(params: unknown): Promise<Json> {
    const body = asRecord(params);
    const name = body.name;
    if (typeof name !== 'string') throw new RpcError(-32602, 'Invalid params');
    const args = body.arguments === undefined ? {} : asRecord(body.arguments);
    try {
      const value = await this.callTool(name, args);
      return toolResult(value, false);
    } catch (error) {
      if (error instanceof RpcError) throw error;
      return toolResult({ error: error instanceof Error ? error.message : String(error) }, true);
    }
  }
  private async callTool(name: string, args: Record<string, unknown>): Promise<Json> {
    if (name === 'acp_delegate_task') return this.delegateTask(args);
    if (name === 'acp_delegate_multi') return this.delegateMulti(args);
    if (name === 'acp_verify_audit_bundle') return this.verifyBundle(args);
    if (name === 'acp_create_invite') return this.createInvite(args);
    if (name === 'acp_revoke_token') return this.revokeToken(args);
    throw new RpcError(-32602, 'Unknown tool');
  }
  private client(relay: RelayTransport | string | undefined): RequesterClient {
    const selected = relay ?? this.options.relay;
    if (!selected) throw new Error('RELAY_REQUIRED');
    return new RequesterClient({
      owner: this.options.owner,
      relay: selected,
      approvalProvider: new PolicyAutoApprovalProvider(this.options.owner),
    });
  }
  private async delegateTask(args: Record<string, unknown>): Promise<Json> {
    const to = typeof args.inviteToken === 'string' ? args.inviteToken : args.workerDid;
    if (typeof to !== 'string' || typeof args.title !== 'string')
      throw new RpcError(-32602, 'Invalid params');
    const relay = typeof args.relayUrl === 'string' ? args.relayUrl : this.options.relay;
    const request: DelegateOptions = {
      to,
      relay,
      title: args.title,
      description: typeof args.description === 'string' ? args.description : '',
      input: (args.input ?? null) as Json,
      outputSchema: args.outputSchema as Schema | undefined,
      budget: args.budget as Partial<BudgetSpec> | undefined,
      minimumIsolationLevel:
        typeof args.minimumIsolationLevel === 'string' ? args.minimumIsolationLevel : undefined,
    };
    const result = await this.client(relay).delegate(request);
    const report = verifyAudit(result.bundle);
    return {
      taskId: result.taskId,
      status: result.state,
      deliverable: result.deliverable,
      auditBundle: {
        valid: report.valid,
        status: report.status,
        count: result.bundle.entries.length,
        head: result.bundle.checkpoint.actor.payload.head,
        taskId: result.taskId,
      },
    };
  }
  private async delegateMulti(args: Record<string, unknown>): Promise<Json> {
    if (!Array.isArray(args.workers) || (args.mode !== 'race' && args.mode !== 'quorum'))
      throw new RpcError(-32602, 'Invalid params');
    if (typeof args.title !== 'string') throw new RpcError(-32602, 'Invalid params');
    const relay = typeof args.relayUrl === 'string' ? args.relayUrl : undefined;
    const workers = args.workers.map((worker) => {
      const item = asRecord(worker);
      if (typeof item.workerDid !== 'string') throw new RpcError(-32602, 'Invalid params');
      return {
        workerDid: item.workerDid,
        inviteToken: typeof item.inviteToken === 'string' ? item.inviteToken : undefined,
        relayUrl: typeof item.relayUrl === 'string' ? item.relayUrl : relay,
      };
    });
    const quorumSize =
      args.quorumSize === undefined
        ? undefined
        : typeof args.quorumSize === 'number'
          ? args.quorumSize
          : Number.NaN;
    const request: DelegateMultiOptions = {
      workers,
      mode: args.mode,
      quorumSize,
      title: args.title,
      description: typeof args.description === 'string' ? args.description : '',
      input: (args.input ?? null) as Json,
      outputSchema: args.outputSchema as Schema | undefined,
      budget: args.budget as Partial<BudgetSpec> | undefined,
      minimumIsolationLevel:
        typeof args.minimumIsolationLevel === 'string' ? args.minimumIsolationLevel : undefined,
    };
    const result = await this.client(relay ?? this.options.relay).delegateMulti(request);
    return {
      mode: result.mode,
      status: result.status,
      deliverable: result.deliverable,
      outputDigest: result.outputDigest,
      taskIds: result.taskIds,
      winners: result.winners as unknown as Json,
      cancelled: result.cancelled,
      auditBundles: result.receipts.map((receipt) => ({
        workerDid: receipt.workerDid,
        taskId: receipt.taskId,
        outputDigest: receipt.outputDigest,
        valid: verifyAudit(receipt.bundle).valid,
        count: receipt.bundle.entries.length,
        head: receipt.bundle.checkpoint.actor.payload.head,
      })),
    };
  }
  private verifyBundle(args: Record<string, unknown>): Json {
    const bundle = args.bundle as AuditBundle;
    if (!bundle || typeof bundle !== 'object') throw new RpcError(-32602, 'Invalid params');
    const anchor = args.anchor as
      | { taskId: string; actors: [string, string]; head?: string }
      | undefined;
    const report = verifyAudit(bundle, anchor);
    return report as unknown as Json;
  }
  private createInvite(args: Record<string, unknown>): Json {
    if (typeof args.relayUrl !== 'string') throw new RpcError(-32602, 'Invalid params');
    const agentDid = typeof args.agentDid === 'string' ? args.agentDid : this.options.owner.did;
    const card = createSignedAgentCard(
      {
        name: typeof args.name === 'string' ? args.name : (this.options.name ?? 'ACP Worker'),
        agentDid,
        relayEndpoint: args.relayUrl,
        skills: [{ id: 'json-task', name: 'JSON task' }],
      },
      this.options.owner,
      agentDid === this.options.owner.did ? undefined : this.options.agentKey,
    );
    const inviteOptions: { agentCard: typeof card; expiresInSeconds?: number } = {
      agentCard: card,
    };
    if (args.expiresInSeconds !== undefined) {
      if (typeof args.expiresInSeconds !== 'number') throw new Error('INVALID_INVITE_EXPIRY');
      inviteOptions.expiresInSeconds = args.expiresInSeconds;
    }
    return {
      inviteToken: createInviteToken(inviteOptions, this.options.owner),
    };
  }
  private revokeToken(args: Record<string, unknown>): Json {
    if (
      (args.targetType !== 'invite' && args.targetType !== 'capability') ||
      typeof args.targetId !== 'string' ||
      typeof args.reason !== 'string'
    )
      throw new RpcError(-32602, 'Invalid params');
    const notice = createRevocationNotice(
      { targetType: args.targetType, targetId: args.targetId, reason: args.reason },
      this.options.owner,
    );
    this.revocation.revoke(notice);
    return { notice: notice as unknown as Json };
  }
}
