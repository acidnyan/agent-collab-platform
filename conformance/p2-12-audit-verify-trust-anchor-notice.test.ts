// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateKeyPair } from '../packages/core/src/index.js';
import type { KeyPair } from '../packages/core/src/index.js';
import {
  AUDIT_VALID_WITHOUT_TRUST_ANCHOR,
  BilateralLedger,
  verifyAudit,
} from '../packages/ledger/src/index.js';
import type { AuditBundle } from '../packages/ledger/src/index.js';
import { AcpMcpServer } from '../packages/runtime/src/mcp-server.js';

function bundle(events: string[], alice: KeyPair, bob: KeyPair, taskId: string): AuditBundle {
  const ledger = new BilateralLedger(taskId, [alice.did, bob.did]);
  events.forEach((eventType, index) => {
    const actor = index % 2 === 0 ? alice : bob;
    const receiver = actor === alice ? bob : alice;
    ledger.append(eventType, { step: index }, actor, receiver);
  });
  return ledger.bundle(alice, bob);
}

function settledPair() {
  const alice = generateKeyPair();
  const bob = generateKeyPair();
  const taskId = 'task_p212';
  return {
    alice,
    bob,
    full: bundle(['PROPOSE', 'ACCEPT', 'SETTLED'], alice, bob, taskId),
    prefix: bundle(['PROPOSE', 'ACCEPT'], alice, bob, taskId),
  };
}

function acp(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const root = fileURLToPath(new URL('..', import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['cli/dist/index.js', ...args], {
      cwd: root,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code }));
  });
}

function writeBundle(dir: string, name: string, value: AuditBundle): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

describe('P2-12 audit-verify trust anchor notice', () => {
  it('labels a valid bundle when no trust anchor is supplied', () => {
    const { full } = settledPair();
    expect(verifyAudit(full)).toEqual({
      valid: true,
      status: 'VALID',
      statusLabel: AUDIT_VALID_WITHOUT_TRUST_ANCHOR,
      trustAnchorVerified: false,
      truncationChecked: false,
    });
    expect(AUDIT_VALID_WITHOUT_TRUST_ANCHOR).toBe(
      'VALID (no trust anchor: truncation not checked)',
    );
  });

  it('prints the truncation notice from acp audit-verify without anchor flags', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-p212-'));
    try {
      const { full } = settledPair();
      const path = writeBundle(dir, 'bundle.json', full);
      const result = await acp(['audit-verify', path]);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('VALID (no trust anchor: truncation not checked)');
      expect(JSON.parse(result.stdout)).toEqual({
        valid: true,
        status: 'VALID',
        statusLabel: 'VALID (no trust anchor: truncation not checked)',
        trustAnchorVerified: false,
        truncationChecked: false,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('verifies a trust anchor and rejects a truncated prefix', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-p212-anchor-'));
    try {
      const { alice, bob, full, prefix } = settledPair();
      const head = full.checkpoint.actor.payload.head;
      const count = full.entries.length;
      expect(head).toEqual(full.entries.at(-1)?.entryHash);
      const options = {
        expectedLastEntryHash: head!,
        expectedEntryCount: count,
        expectedFinalState: 'SETTLED',
      };
      expect(verifyAudit(full, options)).toEqual({
        valid: true,
        status: 'VALID',
        statusLabel: 'VALID',
        trustAnchorVerified: true,
        truncationChecked: true,
      });
      expect(
        verifyAudit(full, {
          taskId: 'task_p212',
          actors: [alice.did, bob.did],
          head: head!,
        }),
      ).toMatchObject({
        valid: true,
        status: 'VALID',
        statusLabel: 'VALID',
        trustAnchorVerified: true,
        truncationChecked: true,
      });
      const rejected = verifyAudit(prefix, options);
      expect(rejected.valid).toBe(false);
      expect(rejected.status).toBe('INVALID');
      expect(rejected.statusLabel).toBe('INVALID');
      expect(rejected.trustAnchorVerified).toBe(false);
      expect(rejected.truncationChecked).toBe(true);
      expect(rejected.reason).toContain('trust anchor');
      expect(verifyAudit(prefix).statusLabel).toBe(AUDIT_VALID_WITHOUT_TRUST_ANCHOR);
      expect(verifyAudit(full, { ...options, expectedEntryCount: count - 1 }).valid).toBe(false);
      expect(verifyAudit(full, { ...options, expectedLastEntryHash: 'sha256:0' }).valid).toBe(
        false,
      );
      expect(verifyAudit(full, { ...options, expectedFinalState: 'ACCEPT' }).valid).toBe(false);

      const path = writeBundle(dir, 'bundle.json', full);
      const prefixPath = writeBundle(dir, 'prefix.json', prefix);
      const anchorPath = join(dir, 'trust-anchor.json');
      writeFileSync(
        anchorPath,
        JSON.stringify({ taskId: 'task_p212', actors: [alice.did, bob.did], head }),
      );
      const verified = await acp([
        'audit-verify',
        path,
        '--expect-final-state',
        'SETTLED',
        '--expect-entry-count',
        String(count),
        '--expect-last-hash',
        head!,
      ]);
      expect(verified.code).toBe(0);
      expect(JSON.parse(verified.stdout)).toMatchObject({
        valid: true,
        status: 'VALID',
        statusLabel: 'VALID',
        trustAnchorVerified: true,
        truncationChecked: true,
      });
      const fileAnchor = await acp(['audit-verify', path, anchorPath]);
      expect(fileAnchor.code).toBe(0);
      expect(JSON.parse(fileAnchor.stdout)).toMatchObject({
        valid: true,
        statusLabel: 'VALID',
        trustAnchorVerified: true,
        truncationChecked: true,
      });
      const truncated = await acp([
        'audit-verify',
        prefixPath,
        '--expect-final-state',
        'SETTLED',
        '--expect-entry-count',
        String(count),
        '--expect-last-hash',
        head!,
      ]);
      expect(truncated.code).toBe(1);
      expect(JSON.parse(truncated.stdout)).toMatchObject({
        valid: false,
        status: 'INVALID',
        statusLabel: 'INVALID',
        trustAnchorVerified: false,
        truncationChecked: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes anchor fields through acp_verify_audit_bundle', async () => {
    const { full, prefix } = settledPair();
    const head = full.checkpoint.actor.payload.head!;
    const server = new AcpMcpServer({
      owner: generateKeyPair(),
      relay: 'http://127.0.0.1:9',
    });
    const call = async (args: Record<string, unknown>) => {
      const response = await server.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'acp_verify_audit_bundle', arguments: args },
      });
      return JSON.parse(
        (response as { result: { content: Array<{ text: string }> } }).result.content[0].text,
      ) as ReturnType<typeof verifyAudit>;
    };
    expect(await call({ bundle: full })).toMatchObject({
      valid: true,
      status: 'VALID',
      statusLabel: 'VALID (no trust anchor: truncation not checked)',
      trustAnchorVerified: false,
      truncationChecked: false,
    });
    expect(
      await call({
        bundle: full,
        expectedFinalState: 'SETTLED',
        expectedLastEntryHash: head,
        expectedEntryCount: full.entries.length,
      }),
    ).toMatchObject({
      valid: true,
      statusLabel: 'VALID',
      trustAnchorVerified: true,
      truncationChecked: true,
    });
    expect(
      await call({
        bundle: prefix,
        expectedFinalState: 'SETTLED',
        expectedEntryCount: full.entries.length,
        expectedLastEntryHash: head,
      }),
    ).toMatchObject({
      valid: false,
      statusLabel: 'INVALID',
      trustAnchorVerified: false,
      truncationChecked: true,
    });
  });
});
