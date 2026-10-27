// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import type { KeyPair } from '@acp/core';
import { generateKeyPair } from '@acp/core';
import { AcpMcpServer } from '@acp/runtime';

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

/** `acp mcp-server [--key <file>] [--relay URL]` speaks MCP over stdio. */
export async function mcpServerCommand(args: string[]): Promise<void> {
  const parsed = flags(args);
  const relay = parsed.get('--relay');
  const owner = resolveOwner(parsed);
  const server = new AcpMcpServer({
    owner,
    relay: typeof relay === 'string' ? relay : undefined,
  });
  await server.serve(process.stdin, process.stdout);
}

/**
 * Load `--key <file>` when it is present. Omitting `--key` mints an in-memory
 * Ed25519 identity so MCP scanners can call `initialize` and `tools/list`
 * without a persisted owner key. `--key` with no path is still a usage error.
 */
function resolveOwner(parsed: Map<string, string | true>): KeyPair {
  if (!parsed.has('--key')) return generateKeyPair();
  const keyFile = parsed.get('--key');
  if (typeof keyFile !== 'string')
    throw new Error('Usage: acp mcp-server [--key <file>] [--relay URL]');
  return JSON.parse(readFileSync(keyFile, 'utf8')) as KeyPair;
}
