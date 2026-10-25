#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { generateKeyPair, validateSchema, signApproval } from '@acp/core';
import type { KeyPair, Gate } from '@acp/core';
import { parseJsonl, verifyAudit } from '@acp/ledger';
import type { AuditBundle } from '@acp/ledger';
import { runDemo } from '@acp/two-owner-demo';
import { networkCommand } from './network.js';
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as unknown;
function save(path: string, value: unknown, privateFile = false) { writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: privateFile ? 0o600 : 0o644, flag: 'wx' }); }
async function main(args: string[]) {
  const [command, ...rest] = args;
  switch (command) {
    case 'relay': case 'worker': case 'delegate': case 'discover': case 'invite': await networkCommand(command, rest); break;
    case 'keygen': {
      if (rest.length !== 1) throw new Error('Usage: acp keygen <owner.private.json>');
      const key = generateKeyPair(); save(rest[0], key, true); console.log(JSON.stringify({ did: key.did, keyFile: rest[0] })); break;
    }
    case 'validate': {
      const schema = rest.length === 1 ? 'task-manifest' : rest[0], path = rest.length === 1 ? rest[0] : rest[1];
      if (!schema || !path) throw new Error('Usage: acp validate [schema-name] <file.json>');
      validateSchema(schema, read(path)); console.log('VALID'); break;
    }
    case 'approve': {
      const [keyFile, gate, taskId, targetFile, outputFile] = rest;
      if (!keyFile || !gate || !taskId || !targetFile || !outputFile) throw new Error('Usage: acp approve <key.private.json> <gate> <taskId> <target.json> <approval.json>');
      if (!['contract_acceptance','external_side_effect','budget_increase','redelegation','final_verification'].includes(gate)) throw new Error('INVALID_GATE');
      const receipt = signApproval(taskId, gate as Gate, read(targetFile), read(keyFile) as KeyPair);
      validateSchema('approval-receipt', receipt); save(outputFile, receipt); console.log(JSON.stringify({ receiptId: receipt.payload.receiptId, outputFile })); break;
    }
    case 'audit-verify': {
      if (!rest[0]) throw new Error('Usage: acp audit-verify <audit.jsonl|bundle.json> [trust-anchor.json]');
      const input = readFileSync(rest[0], 'utf8');
      const bundle = rest[0].endsWith('.jsonl') ? parseJsonl(input) : JSON.parse(input) as AuditBundle;
      const anchor = rest[1] ? read(rest[1]) as { taskId: string; actors: [string,string]; head?: string } : undefined;
      const result = verifyAudit(bundle, anchor); console.log(JSON.stringify(result)); if (!result.valid) process.exitCode = 1; break;
    }
    case 'demo': {
      const index = rest.indexOf('--audit-dir'), directory = index >= 0 ? rest[index + 1] : undefined;
      if (index >= 0 && !directory) throw new Error('Missing --audit-dir value');
      if (directory) mkdirSync(directory, { recursive: true, mode: 0o700 });
      console.log(JSON.stringify(await runDemo(directory), null, 2)); break;
    }
    default: throw new Error('Usage: acp <keygen|validate|approve|audit-verify|demo|relay|worker|delegate|discover|invite>');
  }
}
main(process.argv.slice(2)).catch(error => { console.error(String(error)); process.exitCode = 1; });
