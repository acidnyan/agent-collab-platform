// SPDX-License-Identifier: Apache-2.0 AND MIT
// Adapted from newtro/delegateos src/mcp/plugin.ts (MIT), Scott Smith.
// ACP denies every unconfigured tool; no metadata-free passthrough is supported.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolRequestSchema, CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { CapabilityGuard, digest } from '@acp/core';
import type { CapabilityToken, CapabilityContext, ApprovalReceipt } from '@acp/core';
import { ApprovalGate } from './policy.js';
import type { QuotaMeter } from './quota.js';
export interface ToolBackend {
  callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
}
export interface ToolDefinition {
  resource: (args: Record<string, unknown>) => string;
  readOnly: boolean;
}
export class MCPProxy {
  readonly guard: CapabilityGuard;
  private chain: CapabilityToken[];
  private context: CapabilityContext;
  constructor(options: {
    chain: CapabilityToken[];
    context: CapabilityContext;
    backend: ToolBackend | Client;
    tools: Record<string, ToolDefinition>;
    gate: ApprovalGate;
    meter: QuotaMeter;
    isActive: () => boolean;
    onAudit?: (event: string, details: Record<string, string>) => void;
    guard?: CapabilityGuard;
  }) {
    this.options = options;
    this.chain = structuredClone(options.chain);
    this.context = structuredClone(options.context);
    this.guard = options.guard ?? new CapabilityGuard();
  }
  private options: {
    backend: ToolBackend | Client;
    tools: Record<string, ToolDefinition>;
    gate: ApprovalGate;
    meter: QuotaMeter;
    isActive: () => boolean;
    onAudit?: (event: string, details: Record<string, string>) => void;
  };
  async callTool(
    name: string,
    args: Record<string, unknown>,
    approval?: ApprovalReceipt,
  ): Promise<unknown> {
    const frozenArgs = structuredClone(args);
    try {
      if (!this.options.isActive()) throw new Error('CAPABILITY_VIOLATION: inactive contract');
      const definition = this.options.tools[name];
      if (!Object.hasOwn(this.options.tools, name) || !definition)
        throw new Error('CAPABILITY_VIOLATION: unknown tool');
      this.guard.authorize(
        this.chain,
        { ...this.context, now: Date.now() },
        name,
        frozenArgs,
        definition.resource(frozenArgs),
      );
      if (!definition.readOnly)
        this.options.gate.require(
          this.context.taskId,
          'external_side_effect',
          { name, args: frozenArgs },
          approval,
        );
      this.options.meter.record(0, 0, 1);
      const result = CallToolResultSchema.parse(
        await this.options.backend.callTool({ name, arguments: frozenArgs }),
      );
      this.options.onAudit?.('TOOL_ALLOWED', { name, resultDigest: digest(result) });
      return result;
    } catch (e) {
      this.options.onAudit?.(
        String(e).includes('BUDGET') ? 'BUDGET_EXCEEDED' : 'CAPABILITY_VIOLATION',
        { name, reason: String(e) },
      );
      throw e;
    }
  }
  createServer(): Server {
    const server = new Server(
      { name: 'acp-capguard', version: '0.1.0' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(CallToolRequestSchema, async (request) =>
      CallToolResultSchema.parse(
        await this.callTool(request.params.name, request.params.arguments ?? {}),
      ),
    );
    return server;
  }
}

/** Connect a genuine SDK client/server pair without sockets or credentials. */
export async function connectMCPTools(
  handler: (name: string, args: Record<string, unknown>) => Promise<unknown>,
) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const server = new Server(
    { name: 'acp-owner-tools', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(CallToolRequestSchema, async (req) =>
    CallToolResultSchema.parse(await handler(req.params.name, req.params.arguments ?? {})),
  );
  const client = new Client({ name: 'acp-gateway', version: '0.1.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
