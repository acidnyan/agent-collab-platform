// SPDX-License-Identifier: Apache-2.0
import { it, expect, describe } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair } from '../packages/core/src/index.js';
import {
  BilateralLedger,
  JsonlStore,
  verifyAudit,
  parseJsonl,
} from '../packages/ledger/src/index.js';
import type { AuditBundle } from '../packages/ledger/src/index.js';
const alice = generateKeyPair(),
  bob = generateKeyPair();
function fixture() {
  const ledger = new BilateralLedger('task_ledger001', [alice.did, bob.did]);
  for (let i = 0; i < 4; i++)
    ledger.append('EVENT', { value: i }, i % 2 ? alice : bob, i % 2 ? bob : alice);
  return ledger.bundle(alice, bob);
}
describe('bilateral audit evidence', () => {
  it('verifies both actor orders against pinned identities', () =>
    expect(
      verifyAudit(fixture(), { taskId: 'task_ledger001', actors: [alice.did, bob.did] }).status,
    ).toBe('VALID'));
  const changes: [string, (b: AuditBundle) => void][] = [
    [
      'one-byte payload',
      (b) => {
        b.entries[1].body.payload = { value: 9 };
      },
    ],
    [
      'hash link',
      (b) => {
        b.entries[1].body.prevEntryHash = b.entries[1].entryHash;
      },
    ],
    [
      'interior deletion',
      (b) => {
        b.entries.splice(1, 1);
      },
    ],
    [
      'tail deletion',
      (b) => {
        b.entries.pop();
      },
    ],
    [
      'reordering',
      (b) => {
        b.entries.reverse();
      },
    ],
    [
      'missing actor signature',
      (b) => {
        delete (b.entries[0] as Partial<(typeof b.entries)[0]>).actorSignature;
      },
    ],
    [
      'missing countersignature',
      (b) => {
        delete (b.entries[0] as Partial<(typeof b.entries)[0]>).counterSignature;
      },
    ],
    [
      'invalid actor signature',
      (b) => {
        b.entries[0].actorSignature.signature = 'ed25519:' + 'A'.repeat(86);
      },
    ],
    [
      'invalid receiver signature',
      (b) => {
        b.entries[0].counterSignature.signature.signature = 'ed25519:' + 'A'.repeat(86);
      },
    ],
    [
      'checkpoint count',
      (b) => {
        b.checkpoint.actor.payload.count--;
      },
    ],
    [
      'receiver binding',
      (b) => {
        b.entries[0].counterSignature.payload.receiverDid = bob.did;
      },
    ],
  ];
  for (const [name, change] of changes)
    it('detects ' + name, () => {
      const b = fixture();
      change(b);
      expect(verifyAudit(b).status).toBe('INVALID');
    });
  it('rejects wrong external trust anchor', () =>
    expect(
      verifyAudit(fixture(), { taskId: 'task_ledger001', actors: [bob.did, alice.did] }).valid,
    ).toBe(false));
  it('roundtrips sealed JSONL and detects final-line deletion', () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-ledger-test-'));
    try {
      const path = join(dir, 'audit.jsonl'),
        store = new JsonlStore(path),
        ledger = new BilateralLedger('task_ledger001', [alice.did, bob.did], store);
      ledger.append('PROPOSE', { ok: true }, alice, bob);
      ledger.append('ACCEPT', { ok: true }, bob, alice);
      ledger.bundle(alice, bob);
      const text = readFileSync(path, 'utf8');
      expect(verifyAudit(parseJsonl(text)).valid).toBe(true);
      expect(() => parseJsonl(text.trim().split('\n').slice(0, -1).join('\n'))).toThrow(
        /CHECKPOINT/,
      );
      expect(() => ledger.append('LATE', {}, alice, bob)).toThrow(/SEALED/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
